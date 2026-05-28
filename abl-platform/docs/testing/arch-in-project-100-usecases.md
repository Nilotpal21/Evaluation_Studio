# Arch AI In-Project — 100 Use Case Test Results

**Date**: 2026-04-08
**Branch**: features/arch-ai
**Projects tested**: LearnPilot, PropAssist, TradeGuard, MedConnect, ShopWise Customer Support Bot
**Total**: 100 | **Passed**: 99 | **Failed**: 1 | **Errors**: 0
**Pass Rate**: 99.0%

---

## Category Summary

| Category           | Pass | Fail | Error | Rate |
| ------------------ | ---- | ---- | ----- | ---- |
| Read Agent         | 20   | 0    | 0     | 100% |
| Read Topology      | 5    | 0    | 0     | 100% |
| Health Check       | 5    | 0    | 0     | 100% |
| Modify PERSONA     | 10   | 0    | 0     | 100% |
| Modify LIMITATIONS | 10   | 0    | 0     | 100% |
| Modify GOAL        | 9    | 1    | 0     | 90%  |
| Add Agent          | 10   | 0    | 0     | 100% |
| Modify CONSTRAINTS | 10   | 0    | 0     | 100% |
| Topology Verify    | 10   | 0    | 0     | 100% |
| Mixed              | 10   | 0    | 0     | 100% |

---

## Full Results

| #   | Category           | Description                              | Project              | Status | Duration | Tools                                                               | Error                 |
| --- | ------------------ | ---------------------------------------- | -------------------- | ------ | -------- | ------------------------------------------------------------------- | --------------------- |
| 1   | Read Agent         | Read HomeworkHelpAgent                   | LearnPilot           | PASS   | 12.5s    | read_agent                                                          | -                     |
| 2   | Read Agent         | Read LearningCoordinator                 | LearnPilot           | PASS   | 6.9s     | read_agent                                                          | -                     |
| 3   | Read Agent         | Read MathTutorAgent                      | LearnPilot           | PASS   | 5.5s     | read_agent                                                          | -                     |
| 4   | Read Agent         | Read OnboardingAssessmentAgent           | LearnPilot           | PASS   | 5.2s     | read_agent                                                          | -                     |
| 5   | Read Topology      | Topology of LearnPilot                   | LearnPilot           | PASS   | 7.1s     | read_topology                                                       | -                     |
| 6   | Health Check       | Health of LearnPilot                     | LearnPilot           | PASS   | 9.3s     | health_check                                                        | -                     |
| 7   | Modify PERSONA     | HomeworkHelpAgent persona → professional | LearnPilot           | PASS   | 7.6s     | read_agent, propose_modification                                    | -                     |
| 8   | Modify PERSONA     | LearningCoordinator persona → warm       | LearnPilot           | PASS   | 6.7s     | apply_modification                                                  | -                     |
| 9   | Modify LIMITATIONS | Add limitation to LearningCoordinator    | LearnPilot           | PASS   | 7.9s     | read_agent, propose_modification                                    | -                     |
| 10  | Modify LIMITATIONS | Add limitation to MathTutorAgent         | LearnPilot           | PASS   | 4.7s     | propose_modification                                                | -                     |
| 11  | Modify GOAL        | Update goal of HomeworkHelpAgent         | LearnPilot           | PASS   | 5.3s     | read_agent, propose_modification                                    | -                     |
| 12  | Modify GOAL        | Update goal of LearningCoordinator       | LearnPilot           | PASS   | 4.9s     | apply_modification                                                  | -                     |
| 13  | Add Agent          | Add FeedbackCollector to LearnPilot      | LearnPilot           | PASS   | 13.0s    | generate_agent, compile_abl                                         | -                     |
| 14  | Add Agent          | Add ComplianceMonitor to LearnPilot      | LearnPilot           | PASS   | 5.4s     | generate_agent                                                      | -                     |
| 15  | Modify CONSTRAINTS | Add constraint to HomeworkHelpAgent      | LearnPilot           | PASS   | 5.8s     | read_agent, propose_modification                                    | -                     |
| 16  | Modify CONSTRAINTS | Add constraint to LearningCoordinator    | LearnPilot           | PASS   | 5.5s     | apply_modification                                                  | -                     |
| 17  | Topology Verify    | Verify topology #1 of LearnPilot         | LearnPilot           | PASS   | 7.3s     | read_topology                                                       | -                     |
| 18  | Topology Verify    | Verify topology #2 of LearnPilot         | LearnPilot           | PASS   | 5.6s     | read_topology                                                       | -                     |
| 19  | Mixed              | What agents does this project have and w | LearnPilot           | PASS   | 6.8s     | -                                                                   | -                     |
| 20  | Mixed              | Are there any issues with the current ag | LearnPilot           | PASS   | 8.8s     | health_check                                                        | -                     |
| 21  | Read Agent         | Read FrontDeskConcierge                  | PropAssist           | PASS   | 4.8s     | read_agent                                                          | -                     |
| 22  | Read Agent         | Read LeaseRenewalAgent                   | PropAssist           | PASS   | 6.7s     | read_agent                                                          | -                     |
| 23  | Read Agent         | Read MaintenanceRoutingAgent             | PropAssist           | PASS   | 5.9s     | read_agent                                                          | -                     |
| 24  | Read Agent         | Read PropertyViewingAgent                | PropAssist           | PASS   | 6.7s     | read_agent                                                          | -                     |
| 25  | Read Topology      | Topology of PropAssist                   | PropAssist           | PASS   | 5.5s     | read_topology                                                       | -                     |
| 26  | Health Check       | Health of PropAssist                     | PropAssist           | PASS   | 9.1s     | health_check                                                        | -                     |
| 27  | Modify PERSONA     | FrontDeskConcierge persona → formal      | PropAssist           | PASS   | 8.5s     | read_agent, propose_modification                                    | -                     |
| 28  | Modify PERSONA     | LeaseRenewalAgent persona → casual       | PropAssist           | PASS   | 7.6s     | read_agent, propose_modification                                    | -                     |
| 29  | Modify LIMITATIONS | Add limitation to LeaseRenewalAgent      | PropAssist           | PASS   | 5.8s     | read_agent, propose_modification                                    | -                     |
| 30  | Modify LIMITATIONS | Add limitation to MaintenanceRoutingAgen | PropAssist           | PASS   | 6.4s     | read_agent, propose_modification                                    | -                     |
| 31  | Modify GOAL        | Update goal of FrontDeskConcierge        | PropAssist           | PASS   | 5.6s     | read_agent, propose_modification                                    | -                     |
| 32  | Modify GOAL        | Update goal of LeaseRenewalAgent         | PropAssist           | PASS   | 6.9s     | read_agent, propose_modification                                    | -                     |
| 33  | Add Agent          | Add KnowledgeHelper to PropAssist        | PropAssist           | PASS   | 11.9s    | generate_agent                                                      | -                     |
| 34  | Add Agent          | Add EscalationHandler to PropAssist      | PropAssist           | PASS   | 11.9s    | generate_agent, compile_abl                                         | -                     |
| 35  | Modify CONSTRAINTS | Add constraint to FrontDeskConcierge     | PropAssist           | PASS   | 5.2s     | read_agent, propose_modification                                    | -                     |
| 36  | Modify CONSTRAINTS | Add constraint to LeaseRenewalAgent      | PropAssist           | PASS   | 6.0s     | apply_modification                                                  | -                     |
| 37  | Topology Verify    | Verify topology #1 of PropAssist         | PropAssist           | PASS   | 8.4s     | read_topology                                                       | -                     |
| 38  | Topology Verify    | Verify topology #2 of PropAssist         | PropAssist           | PASS   | 6.3s     | read_topology                                                       | -                     |
| 39  | Mixed              | Suggest improvements for the supervisor  | PropAssist           | PASS   | 14.6s    | read_agent                                                          | -                     |
| 40  | Mixed              | Which agent handles the most critical us | PropAssist           | PASS   | 6.6s     | -                                                                   | -                     |
| 41  | Read Agent         | Read AlertDispatcher                     | TradeGuard           | PASS   | 9.1s     | read_agent                                                          | -                     |
| 42  | Read Agent         | Read MarketMonitor                       | TradeGuard           | PASS   | 7.9s     | read_agent                                                          | -                     |
| 43  | Read Agent         | Read PortfolioRiskAssessment             | TradeGuard           | PASS   | 6.7s     | read_agent                                                          | -                     |
| 44  | Read Agent         | Read RegulatoryComplianceCheck           | TradeGuard           | PASS   | 7.3s     | read_agent                                                          | -                     |
| 45  | Read Topology      | Topology of TradeGuard                   | TradeGuard           | PASS   | 7.4s     | read_topology                                                       | -                     |
| 46  | Health Check       | Health of TradeGuard                     | TradeGuard           | PASS   | 7.6s     | health_check                                                        | -                     |
| 47  | Modify PERSONA     | AlertDispatcher persona → patient        | TradeGuard           | PASS   | 9.7s     | read_agent                                                          | -                     |
| 48  | Modify PERSONA     | MarketMonitor persona → new              | TradeGuard           | PASS   | 7.7s     | read_agent                                                          | -                     |
| 49  | Modify LIMITATIONS | Add limitation to MarketMonitor          | TradeGuard           | PASS   | 7.2s     | propose_modification                                                | -                     |
| 50  | Modify LIMITATIONS | Add limitation to PortfolioRiskAssessmen | TradeGuard           | PASS   | 6.6s     | read_agent, propose_modification                                    | -                     |
| 51  | Modify GOAL        | Update goal of AlertDispatcher           | TradeGuard           | PASS   | 3.9s     | read_agent                                                          | -                     |
| 52  | Modify GOAL        | Update goal of MarketMonitor             | TradeGuard           | PASS   | 6.7s     | read_agent, propose_modification                                    | -                     |
| 53  | Add Agent          | Add AnalyticsReporter to TradeGuard      | TradeGuard           | PASS   | 13.2s    | generate_agent                                                      | -                     |
| 54  | Add Agent          | Add OnboardingGuide to TradeGuard        | TradeGuard           | PASS   | 4.0s     | generate_agent                                                      | -                     |
| 55  | Modify CONSTRAINTS | Add constraint to AlertDispatcher        | TradeGuard           | PASS   | 7.7s     | read_agent, propose_modification                                    | -                     |
| 56  | Modify CONSTRAINTS | Add constraint to MarketMonitor          | TradeGuard           | PASS   | 6.0s     | read_agent, propose_modification                                    | -                     |
| 57  | Topology Verify    | Verify topology #1 of TradeGuard         | TradeGuard           | PASS   | 5.4s     | read_topology                                                       | -                     |
| 58  | Topology Verify    | Verify topology #2 of TradeGuard         | TradeGuard           | PASS   | 6.1s     | read_topology                                                       | -                     |
| 59  | Mixed              | Are there any missing capabilities in th | TradeGuard           | PASS   | 9.9s     | health_check                                                        | -                     |
| 60  | Mixed              | How could we improve error handling acro | TradeGuard           | PASS   | 15.5s    | -                                                                   | -                     |
| 61  | Read Agent         | Read AppointmentBooking                  | MedConnect           | PASS   | 8.2s     | read_agent                                                          | -                     |
| 62  | Read Agent         | Read ClinicalTriage                      | MedConnect           | PASS   | 6.3s     | read_agent                                                          | -                     |
| 63  | Read Agent         | Read HumanCareTeam                       | MedConnect           | PASS   | 6.9s     | read_agent                                                          | -                     |
| 64  | Read Agent         | Read InsuranceVerification               | MedConnect           | PASS   | 7.4s     | read_agent                                                          | -                     |
| 65  | Read Topology      | Topology of MedConnect                   | MedConnect           | PASS   | 7.0s     | read_topology                                                       | -                     |
| 66  | Health Check       | Health of MedConnect                     | MedConnect           | PASS   | 9.7s     | health_check                                                        | -                     |
| 67  | Modify PERSONA     | AppointmentBooking persona → new         | MedConnect           | PASS   | 9.8s     | read_agent, propose_modification                                    | -                     |
| 68  | Modify PERSONA     | ClinicalTriage persona → new             | MedConnect           | PASS   | 7.1s     | read_agent                                                          | -                     |
| 69  | Modify LIMITATIONS | Add limitation to ClinicalTriage         | MedConnect           | PASS   | 3.3s     | read_agent                                                          | -                     |
| 70  | Modify LIMITATIONS | Add limitation to HumanCareTeam          | MedConnect           | PASS   | 3.7s     | read_agent                                                          | -                     |
| 71  | Modify GOAL        | Update goal of AppointmentBooking        | MedConnect           | PASS   | 4.0s     | read_agent                                                          | -                     |
| 72  | Modify GOAL        | Update goal of ClinicalTriage            | MedConnect           | PASS   | 4.0s     | read_agent                                                          | -                     |
| 73  | Add Agent          | Add BillingAssistant to MedConnect       | MedConnect           | PASS   | 15.4s    | generate_agent                                                      | -                     |
| 74  | Add Agent          | Add TechDiagnostic to MedConnect         | MedConnect           | PASS   | 8.6s     | generate_agent, compile_abl                                         | -                     |
| 75  | Modify CONSTRAINTS | Add constraint to AppointmentBooking     | MedConnect           | PASS   | 5.4s     | read_agent                                                          | -                     |
| 76  | Modify CONSTRAINTS | Add constraint to ClinicalTriage         | MedConnect           | PASS   | 8.1s     | read_agent, propose_modification                                    | -                     |
| 77  | Topology Verify    | Verify topology #1 of MedConnect         | MedConnect           | PASS   | 24.3s    | read_agent, propose_modification, apply_modification, read_topology | -                     |
| 78  | Topology Verify    | Verify topology #2 of MedConnect         | MedConnect           | PASS   | 5.2s     | read_topology                                                       | -                     |
| 79  | Mixed              | What guardrails should we add to improve | MedConnect           | PASS   | 12.1s    | analyze_constraints                                                 | -                     |
| 80  | Mixed              | Analyze the handoff patterns between age | MedConnect           | PASS   | 10.5s    | query_traces                                                        | -                     |
| 81  | Read Agent         | Read HumanEscalation                     | ShopWise Customer Su | PASS   | 7.2s     | read_agent                                                          | -                     |
| 82  | Read Agent         | Read OrderSupport                        | ShopWise Customer Su | PASS   | 7.0s     | read_agent                                                          | -                     |
| 83  | Read Agent         | Read ProductInquirySupport               | ShopWise Customer Su | PASS   | 6.1s     | read_agent                                                          | -                     |
| 84  | Read Agent         | Read RefundSupport                       | ShopWise Customer Su | PASS   | 7.3s     | read_agent                                                          | -                     |
| 85  | Read Topology      | Topology of ShopWise Customer Support Bo | ShopWise Customer Su | PASS   | 10.1s    | read_topology                                                       | -                     |
| 86  | Health Check       | Health of ShopWise Customer Support Bot  | ShopWise Customer Su | PASS   | 12.7s    | health_check                                                        | -                     |
| 87  | Modify PERSONA     | HumanEscalation persona → new            | ShopWise Customer Su | PASS   | 5.7s     | read_agent                                                          | -                     |
| 88  | Modify PERSONA     | OrderSupport persona → new               | ShopWise Customer Su | PASS   | 6.1s     | read_agent                                                          | -                     |
| 89  | Modify LIMITATIONS | Add limitation to OrderSupport           | ShopWise Customer Su | PASS   | 6.9s     | propose_modification                                                | -                     |
| 90  | Modify LIMITATIONS | Add limitation to ProductInquirySupport  | ShopWise Customer Su | PASS   | 5.8s     | read_agent                                                          | -                     |
| 91  | Modify GOAL        | Update goal of HumanEscalation           | ShopWise Customer Su | PASS   | 4.9s     | read_agent                                                          | -                     |
| 92  | Modify GOAL        | Update goal of OrderSupport              | ShopWise Customer Su | FAIL   | 2.9s     | -                                                                   | Pass criteria not met |
| 93  | Add Agent          | Add AppointmentScheduler to ShopWise Cus | ShopWise Customer Su | PASS   | 8.0s     | generate_agent                                                      | -                     |
| 94  | Add Agent          | Add ReturnProcessor to ShopWise Customer | ShopWise Customer Su | PASS   | 5.3s     | generate_agent                                                      | -                     |
| 95  | Modify CONSTRAINTS | Add constraint to HumanEscalation        | ShopWise Customer Su | PASS   | 6.9s     | propose_modification                                                | -                     |
| 96  | Modify CONSTRAINTS | Add constraint to OrderSupport           | ShopWise Customer Su | PASS   | 4.1s     | read_agent                                                          | -                     |
| 97  | Topology Verify    | Verify topology #1 of ShopWise Customer  | ShopWise Customer Su | PASS   | 5.4s     | read_topology                                                       | -                     |
| 98  | Topology Verify    | Verify topology #2 of ShopWise Customer  | ShopWise Customer Su | PASS   | 4.8s     | read_topology                                                       | -                     |
| 99  | Mixed              | Which agents could benefit from adding G | ShopWise Customer Su | PASS   | 11.3s    | read_agent                                                          | -                     |
| 100 | Mixed              | Suggest a better conversation flow for t | ShopWise Customer Su | PASS   | 11.9s    | -                                                                   | -                     |

---

## Failures & Errors

- **[92] Modify GOAL**: Update goal of OrderSupport
  - Project: ShopWise Customer Support Bot
  - Status: FAIL
  - Error: Pass criteria not met
