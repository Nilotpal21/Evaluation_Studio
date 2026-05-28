# Arch AI In-Project — 100 Scenario UI Contract Test Results

**Date**: 2026-05-14
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Projects tested**: ComplianceGate Two, ScheduleWise Two, IncidentOps Intake Two, DeskLite FAQ Two, SupportFlow Matrix
**Total**: 100 | **Passed**: 100 | **Failed**: 0 | **Errors**: 0
**Pass Rate**: 100.0%

## **Contract Findings**: Event/order failures 0 | Busy/streaming 0 | Pending proposal 0 | Approval failures 0

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
| Modify CONSTRAINTS | 10   | 0    | 0     | 100% |
| Topology Verify    | 10   | 0    | 0     | 100% |
| Mixed              | 11   | 0    | 0     | 100% |

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

| #   | Category           | Description                              | Project              | Status | Duration | Events | Tool Calls | Turn End | Artifacts | Approval | Error |
| --- | ------------------ | ---------------------------------------- | -------------------- | ------ | -------- | ------ | ---------- | -------- | --------- | -------- | ----- |
| 1   | Read Agent         | Read ComplianceRouter                    | ComplianceGate Two   | PASS   | 28.7s    | 667    | 1          | yes      | 0         | -        | -     |
| 2   | Read Agent         | Read EvidenceIntake                      | ComplianceGate Two   | PASS   | 21.5s    | 567    | 2          | yes      | 0         | -        | -     |
| 3   | Read Agent         | Read HumanEscalation                     | ComplianceGate Two   | PASS   | 18.1s    | 480    | 1          | yes      | 0         | -        | -     |
| 4   | Read Agent         | Read PolicySpecialist                    | ComplianceGate Two   | PASS   | 11.3s    | 603    | 2          | yes      | 0         | -        | -     |
| 5   | Read Topology      | Topology of ComplianceGate Two           | ComplianceGate Two   | PASS   | 16.6s    | 340    | 1          | yes      | 0         | -        | -     |
| 6   | Health Check       | Health of ComplianceGate Two             | ComplianceGate Two   | PASS   | 12.3s    | 677    | 3          | yes      | 0         | -        | -     |
| 7   | Modify PERSONA     | ComplianceRouter persona → professional  | ComplianceGate Two   | PASS   | 21.2s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 8   | Modify PERSONA     | EvidenceIntake persona → warm            | ComplianceGate Two   | PASS   | 23.6s    | 92     | 6          | yes      | 0         | SKIP     | -     |
| 9   | Modify LIMITATIONS | Add limitation to EvidenceIntake         | ComplianceGate Two   | PASS   | 25.2s    | 181    | 3          | yes      | 1         | PASS     | -     |
| 10  | Modify LIMITATIONS | Add limitation to HumanEscalation        | ComplianceGate Two   | PASS   | 21.0s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 11  | Modify GOAL        | Update goal of ComplianceRouter          | ComplianceGate Two   | PASS   | 24.5s    | 21     | 6          | yes      | 0         | SKIP     | -     |
| 12  | Modify GOAL        | Update goal of EvidenceIntake            | ComplianceGate Two   | PASS   | 26.9s    | 115    | 4          | yes      | 0         | SKIP     | -     |
| 13  | Add Agent          | Add FeedbackCollector to ComplianceGate  | ComplianceGate Two   | PASS   | 43.3s    | 25     | 8          | yes      | 2         | PASS     | -     |
| 14  | Add Agent          | Add ComplianceMonitor to ComplianceGate  | ComplianceGate Two   | PASS   | 32.7s    | 24     | 7          | yes      | 2         | PASS     | -     |
| 15  | Modify CONSTRAINTS | Add constraint to ComplianceRouter       | ComplianceGate Two   | PASS   | 47.7s    | 228    | 11         | yes      | 1         | PASS     | -     |
| 16  | Modify CONSTRAINTS | Add constraint to EvidenceIntake         | ComplianceGate Two   | PASS   | 28.5s    | 32     | 11         | yes      | 1         | PASS     | -     |
| 17  | Topology Verify    | Verify topology #1 of ComplianceGate Two | ComplianceGate Two   | PASS   | 8.9s     | 402    | 2          | yes      | 0         | -        | -     |
| 18  | Topology Verify    | Verify topology #2 of ComplianceGate Two | ComplianceGate Two   | PASS   | 9.7s     | 258    | 2          | yes      | 0         | -        | -     |
| 19  | Mixed              | What agents does this project have and w | ComplianceGate Two   | PASS   | 11.1s    | 383    | 2          | yes      | 0         | -        | -     |
| 20  | Mixed              | Are there any issues with the current ag | ComplianceGate Two   | PASS   | 14.9s    | 811    | 3          | yes      | 0         | -        | -     |
| 21  | Read Agent         | Read AvailabilitySpecialist              | ScheduleWise Two     | PASS   | 12.4s    | 520    | 1          | yes      | 0         | -        | -     |
| 22  | Read Agent         | Read BookingSpecialist                   | ScheduleWise Two     | PASS   | 15.0s    | 574    | 2          | yes      | 0         | -        | -     |
| 23  | Read Agent         | Read ChangeCancelSpecialist              | ScheduleWise Two     | PASS   | 16.2s    | 679    | 2          | yes      | 0         | -        | -     |
| 24  | Read Agent         | Read HumanEscalationSpecialist           | ScheduleWise Two     | PASS   | 11.3s    | 521    | 2          | yes      | 0         | -        | -     |
| 25  | Read Topology      | Topology of ScheduleWise Two             | ScheduleWise Two     | PASS   | 11.2s    | 593    | 1          | yes      | 0         | -        | -     |
| 26  | Health Check       | Health of ScheduleWise Two               | ScheduleWise Two     | PASS   | 15.3s    | 796    | 3          | yes      | 0         | -        | -     |
| 27  | Modify PERSONA     | AvailabilitySpecialist persona → formal  | ScheduleWise Two     | PASS   | 24.8s    | 207    | 6          | yes      | 0         | SKIP     | -     |
| 28  | Modify PERSONA     | BookingSpecialist persona → casual       | ScheduleWise Two     | PASS   | 32.3s    | 86     | 6          | yes      | 1         | PASS     | -     |
| 29  | Modify LIMITATIONS | Add limitation to BookingSpecialist      | ScheduleWise Two     | PASS   | 22.5s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 30  | Modify LIMITATIONS | Add limitation to ChangeCancelSpecialist | ScheduleWise Two     | PASS   | 27.5s    | 125    | 3          | yes      | 1         | PASS     | -     |
| 31  | Modify GOAL        | Update goal of AvailabilitySpecialist    | ScheduleWise Two     | PASS   | 18.4s    | 21     | 6          | yes      | 0         | SKIP     | -     |
| 32  | Modify GOAL        | Update goal of BookingSpecialist         | ScheduleWise Two     | PASS   | 11.8s    | 130    | 4          | yes      | 0         | SKIP     | -     |
| 33  | Add Agent          | Add KnowledgeHelper to ScheduleWise Two  | ScheduleWise Two     | PASS   | 34.5s    | 27     | 9          | yes      | 1         | PASS     | -     |
| 34  | Add Agent          | Add EscalationHandler to ScheduleWise Tw | ScheduleWise Two     | PASS   | 31.3s    | 24     | 7          | yes      | 2         | PASS     | -     |
| 35  | Modify CONSTRAINTS | Add constraint to AvailabilitySpecialist | ScheduleWise Two     | PASS   | 30.0s    | 26     | 8          | yes      | 1         | PASS     | -     |
| 36  | Modify CONSTRAINTS | Add constraint to BookingSpecialist      | ScheduleWise Two     | PASS   | 19.4s    | 16     | 4          | yes      | 1         | PASS     | -     |
| 37  | Topology Verify    | Verify topology #1 of ScheduleWise Two   | ScheduleWise Two     | PASS   | 9.6s     | 559    | 1          | yes      | 0         | -        | -     |
| 38  | Topology Verify    | Verify topology #2 of ScheduleWise Two   | ScheduleWise Two     | PASS   | 11.5s    | 326    | 2          | yes      | 0         | -        | -     |
| 39  | Mixed              | Suggest improvements for the supervisor  | ScheduleWise Two     | PASS   | 20.0s    | 1152   | 5          | yes      | 0         | -        | -     |
| 40  | Mixed              | Which agent handles the most critical us | ScheduleWise Two     | PASS   | 8.5s     | 310    | 2          | yes      | 0         | -        | -     |
| 41  | Read Agent         | Read HumanEscalationDesk                 | IncidentOps Intake T | PASS   | 9.4s     | 472    | 1          | yes      | 0         | -        | -     |
| 42  | Read Agent         | Read IncidentIntake                      | IncidentOps Intake T | PASS   | 14.5s    | 703    | 2          | yes      | 0         | -        | -     |
| 43  | Read Agent         | Read IncidentRouter                      | IncidentOps Intake T | PASS   | 15.4s    | 557    | 2          | yes      | 0         | -        | -     |
| 44  | Read Agent         | Read LightweightDiagnostics              | IncidentOps Intake T | PASS   | 13.8s    | 587    | 2          | yes      | 0         | -        | -     |
| 45  | Read Topology      | Topology of IncidentOps Intake Two       | IncidentOps Intake T | PASS   | 10.6s    | 515    | 1          | yes      | 0         | -        | -     |
| 46  | Health Check       | Health of IncidentOps Intake Two         | IncidentOps Intake T | PASS   | 17.4s    | 1078   | 2          | yes      | 0         | -        | -     |
| 47  | Modify PERSONA     | HumanEscalationDesk persona → patient    | IncidentOps Intake T | PASS   | 18.2s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 48  | Modify PERSONA     | IncidentIntake persona → new             | IncidentOps Intake T | PASS   | 33.8s    | 204    | 6          | yes      | 1         | PASS     | -     |
| 49  | Modify LIMITATIONS | Add limitation to IncidentIntake         | IncidentOps Intake T | PASS   | 33.5s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 50  | Modify LIMITATIONS | Add limitation to IncidentRouter         | IncidentOps Intake T | PASS   | 14.3s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 51  | Modify GOAL        | Update goal of HumanEscalationDesk       | IncidentOps Intake T | PASS   | 21.5s    | 196    | 3          | yes      | 1         | PASS     | -     |
| 52  | Modify GOAL        | Update goal of IncidentIntake            | IncidentOps Intake T | PASS   | 22.8s    | 19     | 5          | yes      | 0         | SKIP     | -     |
| 53  | Add Agent          | Add AnalyticsReporter to IncidentOps Int | IncidentOps Intake T | PASS   | 32.0s    | 21     | 6          | yes      | 2         | PASS     | -     |
| 54  | Add Agent          | Add OnboardingGuide to IncidentOps Intak | IncidentOps Intake T | PASS   | 39.7s    | 186    | 6          | yes      | 2         | PASS     | -     |
| 55  | Modify CONSTRAINTS | Add constraint to HumanEscalationDesk    | IncidentOps Intake T | PASS   | 32.6s    | 39     | 15         | yes      | 1         | PASS     | -     |
| 56  | Modify CONSTRAINTS | Add constraint to IncidentIntake         | IncidentOps Intake T | PASS   | 20.5s    | 20     | 6          | yes      | 1         | PASS     | -     |
| 57  | Topology Verify    | Verify topology #1 of IncidentOps Intake | IncidentOps Intake T | PASS   | 8.2s     | 343    | 1          | yes      | 0         | -        | -     |
| 58  | Topology Verify    | Verify topology #2 of IncidentOps Intake | IncidentOps Intake T | PASS   | 9.6s     | 209    | 2          | yes      | 0         | -        | -     |
| 59  | Mixed              | Are there any missing capabilities in th | IncidentOps Intake T | PASS   | 20.0s    | 811    | 4          | yes      | 0         | -        | -     |
| 60  | Mixed              | How could we improve error handling acro | IncidentOps Intake T | PASS   | 28.1s    | 1494   | 5          | yes      | 0         | -        | -     |
| 61  | Read Agent         | Read HelpdeskRouter                      | DeskLite FAQ Two     | PASS   | 11.8s    | 424    | 2          | yes      | 0         | -        | -     |
| 62  | Read Agent         | Read HumanEscalation                     | DeskLite FAQ Two     | PASS   | 14.3s    | 460    | 2          | yes      | 0         | -        | -     |
| 63  | Read Agent         | Read SupportSpecialist                   | DeskLite FAQ Two     | PASS   | 12.6s    | 489    | 2          | yes      | 0         | -        | -     |
| 64  | Read Topology      | Topology of DeskLite FAQ Two             | DeskLite FAQ Two     | PASS   | 8.1s     | 291    | 1          | yes      | 0         | -        | -     |
| 65  | Health Check       | Health of DeskLite FAQ Two               | DeskLite FAQ Two     | PASS   | 12.1s    | 341    | 3          | yes      | 0         | -        | -     |
| 66  | Modify PERSONA     | HelpdeskRouter persona → new             | DeskLite FAQ Two     | PASS   | 29.5s    | 134    | 5          | yes      | 1         | PASS     | -     |
| 67  | Modify PERSONA     | HumanEscalation persona → new            | DeskLite FAQ Two     | PASS   | 16.9s    | 134    | 4          | yes      | 0         | SKIP     | -     |
| 68  | Modify LIMITATIONS | Add limitation to HumanEscalation        | DeskLite FAQ Two     | PASS   | 16.5s    | 102    | 4          | yes      | 0         | SKIP     | -     |
| 69  | Modify LIMITATIONS | Add limitation to SupportSpecialist      | DeskLite FAQ Two     | PASS   | 14.1s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 70  | Modify GOAL        | Update goal of HelpdeskRouter            | DeskLite FAQ Two     | PASS   | 17.7s    | 177    | 4          | yes      | 0         | SKIP     | -     |
| 71  | Modify GOAL        | Update goal of HumanEscalation           | DeskLite FAQ Two     | PASS   | 14.1s    | 153    | 4          | yes      | 0         | SKIP     | -     |
| 72  | Add Agent          | Add BillingAssistant to DeskLite FAQ Two | DeskLite FAQ Two     | PASS   | 42.6s    | 30     | 9          | yes      | 2         | PASS     | -     |
| 73  | Add Agent          | Add TechDiagnostic to DeskLite FAQ Two   | DeskLite FAQ Two     | PASS   | 34.6s    | 24     | 7          | yes      | 2         | PASS     | -     |
| 74  | Modify CONSTRAINTS | Add constraint to HelpdeskRouter         | DeskLite FAQ Two     | PASS   | 27.4s    | 20     | 6          | yes      | 1         | PASS     | -     |
| 75  | Modify CONSTRAINTS | Add constraint to HumanEscalation        | DeskLite FAQ Two     | PASS   | 18.9s    | 20     | 6          | yes      | 1         | PASS     | -     |
| 76  | Topology Verify    | Verify topology #1 of DeskLite FAQ Two   | DeskLite FAQ Two     | PASS   | 8.6s     | 355    | 2          | yes      | 0         | -        | -     |
| 77  | Topology Verify    | Verify topology #2 of DeskLite FAQ Two   | DeskLite FAQ Two     | PASS   | 10.7s    | 217    | 2          | yes      | 0         | -        | -     |
| 78  | Mixed              | What guardrails should we add to improve | DeskLite FAQ Two     | PASS   | 24.3s    | 1516   | 6          | yes      | 0         | -        | -     |
| 79  | Mixed              | Analyze the handoff patterns between age | DeskLite FAQ Two     | PASS   | 51.2s    | 1302   | 7          | yes      | 0         | -        | -     |
| 80  | Read Agent         | Read FaqPolicySpecialist                 | SupportFlow Matrix   | PASS   | 11.2s    | 519    | 1          | yes      | 0         | -        | -     |
| 81  | Read Agent         | Read HumanEscalationSpecialist           | SupportFlow Matrix   | PASS   | 8.9s     | 393    | 1          | yes      | 0         | -        | -     |
| 82  | Read Agent         | Read OrderSupportSpecialist              | SupportFlow Matrix   | PASS   | 14.6s    | 679    | 2          | yes      | 0         | -        | -     |
| 83  | Read Agent         | Read ReturnsClaimsSpecialist             | SupportFlow Matrix   | PASS   | 12.5s    | 461    | 1          | yes      | 0         | -        | -     |
| 84  | Read Topology      | Topology of SupportFlow Matrix           | SupportFlow Matrix   | PASS   | 7.6s     | 304    | 1          | yes      | 0         | -        | -     |
| 85  | Health Check       | Health of SupportFlow Matrix             | SupportFlow Matrix   | PASS   | 8.0s     | 326    | 1          | yes      | 0         | -        | -     |
| 86  | Modify PERSONA     | FaqPolicySpecialist persona → new        | SupportFlow Matrix   | PASS   | 28.3s    | 80     | 5          | yes      | 0         | SKIP     | -     |
| 87  | Modify PERSONA     | HumanEscalationSpecialist persona → new  | SupportFlow Matrix   | PASS   | 31.6s    | 206    | 5          | yes      | 1         | PASS     | -     |
| 88  | Modify LIMITATIONS | Add limitation to HumanEscalationSpecial | SupportFlow Matrix   | PASS   | 14.7s    | 46     | 5          | yes      | 0         | SKIP     | -     |
| 89  | Modify LIMITATIONS | Add limitation to OrderSupportSpecialist | SupportFlow Matrix   | PASS   | 19.5s    | 130    | 3          | yes      | 1         | PASS     | -     |
| 90  | Modify GOAL        | Update goal of FaqPolicySpecialist       | SupportFlow Matrix   | PASS   | 26.2s    | 190    | 5          | yes      | 1         | PASS     | -     |
| 91  | Modify GOAL        | Update goal of HumanEscalationSpecialist | SupportFlow Matrix   | PASS   | 22.0s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 92  | Add Agent          | Add AppointmentScheduler to SupportFlow  | SupportFlow Matrix   | PASS   | 34.8s    | 184    | 7          | yes      | 2         | PASS     | -     |
| 93  | Add Agent          | Add ReturnProcessor to SupportFlow Matri | SupportFlow Matrix   | PASS   | 28.2s    | 24     | 7          | yes      | 2         | PASS     | -     |
| 94  | Modify CONSTRAINTS | Add constraint to FaqPolicySpecialist    | SupportFlow Matrix   | PASS   | 31.2s    | 29     | 9          | yes      | 1         | PASS     | -     |
| 95  | Modify CONSTRAINTS | Add constraint to HumanEscalationSpecial | SupportFlow Matrix   | PASS   | 20.2s    | 23     | 7          | yes      | 1         | PASS     | -     |
| 96  | Topology Verify    | Verify topology #1 of SupportFlow Matrix | SupportFlow Matrix   | PASS   | 10.0s    | 435    | 1          | yes      | 0         | -        | -     |
| 97  | Topology Verify    | Verify topology #2 of SupportFlow Matrix | SupportFlow Matrix   | PASS   | 10.0s    | 319    | 2          | yes      | 0         | -        | -     |
| 98  | Mixed              | Which agents could benefit from adding G | SupportFlow Matrix   | PASS   | 30.9s    | 1039   | 10         | yes      | 0         | -        | -     |
| 99  | Mixed              | Suggest a better conversation flow for t | SupportFlow Matrix   | PASS   | 27.8s    | 1421   | 3          | yes      | 0         | -        | -     |
| 100 | Mixed              | Summarize tools and responsibilities for | ComplianceGate Two   | PASS   | 17.3s    | 860    | 2          | yes      | 0         | -        | -     |
