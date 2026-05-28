# Arch AI In-Project — 50 Scenario UI Contract Test Results

**Date**: 2026-05-14
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Projects tested**: AppointmentHub, OrderHelp, DispatchOps Round2 isorflow, DispatchOps Round2 -topthen, DispatchOps Round2 nsuccess
**Total**: 50 | **Passed**: 50 | **Failed**: 0 | **Errors**: 0
**Pass Rate**: 100.0%

## **Contract Findings**: Event/order failures 0 | Busy/streaming 0 | Pending proposal 0 | Approval failures 0

## Category Summary

| Category           | Pass | Fail | Error | Rate |
| ------------------ | ---- | ---- | ----- | ---- |
| Read Agent         | 11   | 0    | 0     | 100% |
| Read Topology      | 3    | 0    | 0     | 100% |
| Health Check       | 3    | 0    | 0     | 100% |
| Modify PERSONA     | 6    | 0    | 0     | 100% |
| Modify LIMITATIONS | 6    | 0    | 0     | 100% |
| Modify GOAL        | 5    | 0    | 0     | 100% |
| Add Agent          | 4    | 0    | 0     | 100% |
| Modify CONSTRAINTS | 4    | 0    | 0     | 100% |
| Topology Verify    | 4    | 0    | 0     | 100% |
| Mixed              | 4    | 0    | 0     | 100% |

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
| 1   | Read Agent         | Read AvailabilityBookingSpecialist       | AppointmentHub       | PASS   | 14.7s    | 595    | 2          | yes      | 0         | -        | -     |
| 2   | Read Agent         | Read BookingChangeSpecialist             | AppointmentHub       | PASS   | 11.8s    | 574    | 1          | yes      | 0         | -        | -     |
| 3   | Read Agent         | Read HumanEscalationSpecialist           | AppointmentHub       | PASS   | 11.6s    | 503    | 2          | yes      | 0         | -        | -     |
| 4   | Read Agent         | Read SchedulingFaqSpecialist             | AppointmentHub       | PASS   | 10.5s    | 457    | 1          | yes      | 0         | -        | -     |
| 5   | Read Topology      | Topology of AppointmentHub               | AppointmentHub       | PASS   | 11.7s    | 395    | 1          | yes      | 0         | -        | -     |
| 6   | Health Check       | Health of AppointmentHub                 | AppointmentHub       | PASS   | 12.8s    | 684    | 2          | yes      | 0         | -        | -     |
| 7   | Modify PERSONA     | AvailabilityBookingSpecialist persona →  | AppointmentHub       | PASS   | 17.3s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 8   | Modify PERSONA     | BookingChangeSpecialist persona → warm   | AppointmentHub       | PASS   | 35.1s    | 189    | 5          | yes      | 1         | PASS     | -     |
| 9   | Modify LIMITATIONS | Add limitation to BookingChangeSpecialis | AppointmentHub       | PASS   | 33.2s    | 147    | 5          | yes      | 1         | PASS     | -     |
| 10  | Modify LIMITATIONS | Add limitation to HumanEscalationSpecial | AppointmentHub       | PASS   | 32.2s    | 24     | 7          | yes      | 1         | PASS     | -     |
| 11  | Modify GOAL        | Update goal of AvailabilityBookingSpecia | AppointmentHub       | PASS   | 16.8s    | 102    | 5          | yes      | 0         | SKIP     | -     |
| 12  | Modify GOAL        | Update goal of BookingChangeSpecialist   | AppointmentHub       | PASS   | 16.5s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 13  | Add Agent          | Add FeedbackCollector to AppointmentHub  | AppointmentHub       | PASS   | 36.8s    | 215    | 8          | yes      | 2         | PASS     | -     |
| 14  | Add Agent          | Add ComplianceMonitor to AppointmentHub  | AppointmentHub       | PASS   | 36.6s    | 208    | 6          | yes      | 2         | PASS     | -     |
| 15  | Modify CONSTRAINTS | Add constraint to AvailabilityBookingSpe | AppointmentHub       | PASS   | 57.4s    | 218    | 10         | yes      | 1         | PASS     | -     |
| 16  | Modify CONSTRAINTS | Add constraint to BookingChangeSpecialis | AppointmentHub       | PASS   | 51.6s    | 35     | 12         | yes      | 1         | PASS     | -     |
| 17  | Topology Verify    | Verify topology #1 of AppointmentHub     | AppointmentHub       | PASS   | 9.1s     | 294    | 1          | yes      | 0         | -        | -     |
| 18  | Topology Verify    | Verify topology #2 of AppointmentHub     | AppointmentHub       | PASS   | 7.2s     | 235    | 2          | yes      | 0         | -        | -     |
| 19  | Mixed              | What agents does this project have and w | AppointmentHub       | PASS   | 10.9s    | 387    | 2          | yes      | 0         | -        | -     |
| 20  | Mixed              | Are there any issues with the current ag | AppointmentHub       | PASS   | 14.9s    | 827    | 3          | yes      | 0         | -        | -     |
| 21  | Read Agent         | Read HumanEscalationSpecialist           | OrderHelp            | PASS   | 9.3s     | 427    | 1          | yes      | 0         | -        | -     |
| 22  | Read Agent         | Read OrderStatusSpecialist               | OrderHelp            | PASS   | 9.5s     | 393    | 1          | yes      | 0         | -        | -     |
| 23  | Read Agent         | Read ProductAccountFAQSpecialist         | OrderHelp            | PASS   | 13.5s    | 481    | 2          | yes      | 0         | -        | -     |
| 24  | Read Agent         | Read ReturnsRefundsSpecialist            | OrderHelp            | PASS   | 12.0s    | 537    | 1          | yes      | 0         | -        | -     |
| 25  | Read Topology      | Topology of OrderHelp                    | OrderHelp            | PASS   | 11.3s    | 506    | 1          | yes      | 0         | -        | -     |
| 26  | Health Check       | Health of OrderHelp                      | OrderHelp            | PASS   | 9.9s     | 501    | 1          | yes      | 0         | -        | -     |
| 27  | Modify PERSONA     | HumanEscalationSpecialist persona → form | OrderHelp            | PASS   | 25.0s    | 217    | 4          | yes      | 0         | SKIP     | -     |
| 28  | Modify PERSONA     | OrderStatusSpecialist persona → casual   | OrderHelp            | PASS   | 28.5s    | 188    | 5          | yes      | 1         | PASS     | -     |
| 29  | Modify LIMITATIONS | Add limitation to OrderStatusSpecialist  | OrderHelp            | PASS   | 24.6s    | 154    | 3          | yes      | 1         | PASS     | -     |
| 30  | Modify LIMITATIONS | Add limitation to ProductAccountFAQSpeci | OrderHelp            | PASS   | 7.8s     | 115    | 2          | yes      | 0         | SKIP     | -     |
| 31  | Modify GOAL        | Update goal of HumanEscalationSpecialist | OrderHelp            | PASS   | 20.2s    | 187    | 3          | yes      | 1         | PASS     | -     |
| 32  | Modify GOAL        | Update goal of OrderStatusSpecialist     | OrderHelp            | PASS   | 16.3s    | 196    | 5          | yes      | 0         | SKIP     | -     |
| 33  | Add Agent          | Add KnowledgeHelper to OrderHelp         | OrderHelp            | PASS   | 23.7s    | 19     | 6          | yes      | 0         | SKIP     | -     |
| 34  | Add Agent          | Add EscalationHandler to OrderHelp       | OrderHelp            | PASS   | 38.3s    | 26     | 8          | yes      | 2         | PASS     | -     |
| 35  | Modify CONSTRAINTS | Add constraint to HumanEscalationSpecial | OrderHelp            | PASS   | 24.7s    | 24     | 8          | yes      | 1         | PASS     | -     |
| 36  | Modify CONSTRAINTS | Add constraint to OrderStatusSpecialist  | OrderHelp            | PASS   | 21.4s    | 18     | 5          | yes      | 1         | PASS     | -     |
| 37  | Topology Verify    | Verify topology #1 of OrderHelp          | OrderHelp            | PASS   | 7.9s     | 430    | 1          | yes      | 0         | -        | -     |
| 38  | Topology Verify    | Verify topology #2 of OrderHelp          | OrderHelp            | PASS   | 7.2s     | 276    | 2          | yes      | 0         | -        | -     |
| 39  | Mixed              | Suggest improvements for the supervisor  | OrderHelp            | PASS   | 27.4s    | 1709   | 2          | yes      | 0         | -        | -     |
| 40  | Mixed              | Which agent handles the most critical us | OrderHelp            | PASS   | 10.4s    | 363    | 3          | yes      | 0         | -        | -     |
| 41  | Read Agent         | Read DispatchOpsRound2IsorflowIntakeAgen | DispatchOps Round2 i | PASS   | 18.5s    | 660    | 2          | yes      | 0         | -        | -     |
| 42  | Read Agent         | Read DispatchOpsRound2IsorflowProcessorA | DispatchOps Round2 i | PASS   | 9.9s     | 396    | 1          | yes      | 0         | -        | -     |
| 43  | Read Agent         | Read DispatchOpsRound2IsorflowReviewerAg | DispatchOps Round2 i | PASS   | 11.2s    | 453    | 2          | yes      | 0         | -        | -     |
| 44  | Read Topology      | Topology of DispatchOps Round2 isorflow  | DispatchOps Round2 i | PASS   | 7.1s     | 306    | 1          | yes      | 0         | -        | -     |
| 45  | Health Check       | Health of DispatchOps Round2 isorflow    | DispatchOps Round2 i | PASS   | 9.5s     | 411    | 3          | yes      | 0         | -        | -     |
| 46  | Modify PERSONA     | DispatchOpsRound2IsorflowIntakeAgent per | DispatchOps Round2 i | PASS   | 35.5s    | 210    | 6          | yes      | 1         | PASS     | -     |
| 47  | Modify PERSONA     | DispatchOpsRound2IsorflowProcessorAgent  | DispatchOps Round2 i | PASS   | 16.9s    | 14     | 3          | yes      | 1         | PASS     | -     |
| 48  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 17.3s    | 152    | 5          | yes      | 0         | SKIP     | -     |
| 49  | Modify LIMITATIONS | Add limitation to DispatchOpsRound2Isorf | DispatchOps Round2 i | PASS   | 29.6s    | 232    | 5          | yes      | 1         | PASS     | -     |
| 50  | Modify GOAL        | Update goal of DispatchOpsRound2Isorflow | DispatchOps Round2 i | PASS   | 15.5s    | 198    | 3          | yes      | 1         | PASS     | -     |
