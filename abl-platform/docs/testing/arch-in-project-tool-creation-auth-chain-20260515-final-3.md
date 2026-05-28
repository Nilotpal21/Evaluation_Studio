# Arch AI In-Project — 30 Tool Creation Scenario UI Contract Test Results

**Date**: 2026-05-15
**Mode**: CLI-driven Studio SSE + proposal approval contract
**Scenario Set**: tools
**Projects tested**: CarrierCare Round2 5-102207, JourneyBuilder Round2 5-101323, TenantLaunch Round2 5-101323, CareTriage Round2 5-101323, CarrierCare Round2 5-101323
**Total**: 30 | **Passed**: 30 | **Failed**: 0 | **Skipped**: 0 | **Errors**: 0
**Scorable Pass Rate**: 100.0%
**Raw Pass Rate**: 100.0%
**External Runtime Blockers**: 0

## **Contract Findings**: Event/order failures 0 | Busy/streaming 0 | Pending proposal 0 | Approval failures 0

## Category Summary

| Category                        | Pass | Fail | Skip | Error | Scorable Rate |
| ------------------------------- | ---- | ---- | ---- | ----- | ------------- |
| Tool Implied By Agent           | 5    | 0    | 0    | 0     | 100           |
| Tool Suggested From Diagnosis   | 5    | 0    | 0    | 0     | 100           |
| Tool Suggested From Read Agent  | 5    | 0    | 0    | 0     | 100           |
| Direct Tool Creation Assistance | 5    | 0    | 0    | 0     | 100           |
| Tool Auth Secret Chain          | 5    | 0    | 0    | 0     | 100           |
| Tool OAuth Callback Chain       | 5    | 0    | 0    | 0     | 100           |

---

## UI/Backend Contract Summary

| Check                                              | Count |
| -------------------------------------------------- | ----- |
| Event ordering / turn completion / protocol issues | 0     |
| Busy or already-streaming errors                   | 0     |
| Pending proposal errors                            | 0     |
| Approval failures                                  | 0     |
| External runtime/provider blockers                 | 0     |
| Tool-call limit risks                              | 0     |

---

## Full Results

| #   | Category                        | Description                              | Project              | Status | Duration | Events | Tool Calls | Tools                                                                            | Turn End | Artifacts | Approval | Error |
| --- | ------------------------------- | ---------------------------------------- | -------------------- | ------ | -------- | ------ | ---------- | -------------------------------------------------------------------------------- | -------- | --------- | -------- | ----- |
| 1   | Tool Implied By Agent           | Agent creation implies warranty_lookup   | CarrierCare Round2 5 | PASS   | 46.7s    | 30     | 10         | read_topology, read_agent, platform_context, tools_ops, find_tool_consumers, get | yes      | 1         | -        | -     |
| 2   | Tool Suggested From Diagnosis   | Diagnose tools for CarrierCare Round2 5- | CarrierCare Round2 5 | PASS   | 14.7s    | 641    | 4          | read_topology, diagnose_project, platform_context, agent_ops                     | yes      | 0         | -        | -     |
| 3   | Tool Suggested From Read Agent  | Read BillingDisputeSpecialist tool conte | CarrierCare Round2 5 | PASS   | 12.6s    | 576    | 3          | read_agent, read_topology, platform_context                                      | yes      | 0         | -        | -     |
| 4   | Direct Tool Creation Assistance | Plan HTTP tool for CarrierCareRouter     | CarrierCare Round2 5 | PASS   | 33.7s    | 594    | 6          | platform_context, read_agent, read_topology, tools_ops, variable_ops, propose_pl | yes      | 1         | -        | -     |
| 5   | Tool Auth Secret Chain          | Create auth-backed tool for CarrierCareR | CarrierCare Round2 5 | PASS   | 9.6s     | 70     | 3          | platform_context, tools_ops, auth_ops, collect_secret                            | yes      | 0         | -        | -     |
| 6   | Tool OAuth Callback Chain       | Plan OAuth callback tool for CarrierCare | CarrierCare Round2 5 | PASS   | 47.8s    | 27     | 8          | platform_context, tools_ops, read_agent, read_topology, find_tool_consumers, var | yes      | 1         | -        | -     |
| 7   | Tool Implied By Agent           | Agent creation implies shipment_eta_look | JourneyBuilder Round | PASS   | 44.3s    | 25     | 8          | read_topology, platform_context, get_construct_spec, run_feasibility_check, read | yes      | 1         | -        | -     |
| 8   | Tool Suggested From Diagnosis   | Diagnose tools for JourneyBuilder Round2 | JourneyBuilder Round | PASS   | 15.0s    | 665    | 3          | read_topology, platform_context, diagnose_project                                | yes      | 0         | -        | -     |
| 9   | Tool Suggested From Read Agent  | Read BookingManager tool context         | JourneyBuilder Round | PASS   | 11.5s    | 546    | 3          | read_agent, read_topology, platform_context                                      | yes      | 0         | -        | -     |
| 10  | Direct Tool Creation Assistance | Plan HTTP tool for HumanEscalationDesk   | JourneyBuilder Round | PASS   | 29.3s    | 25     | 7          | tools_ops, platform_context, read_agent, read_topology, find_tool_consumers, var | yes      | 1         | -        | -     |
| 11  | Tool Auth Secret Chain          | Create auth-backed tool for HumanEscalat | JourneyBuilder Round | PASS   | 13.3s    | 67     | 2          | auth_ops, tools_ops, ask_user                                                    | yes      | 0         | -        | -     |
| 12  | Tool OAuth Callback Chain       | Plan OAuth callback tool for HumanEscala | JourneyBuilder Round | PASS   | 35.8s    | 28     | 8          | read_agent, read_topology, platform_context, tools_ops, find_tool_consumers, var | yes      | 1         | -        | -     |
| 13  | Tool Implied By Agent           | Agent creation implies customer_status_l | TenantLaunch Round2  | PASS   | 31.7s    | 18     | 5          | read_topology, platform_context, find_agent_refs, propose_plan, propose_plan, as | yes      | 1         | -        | -     |
| 14  | Tool Suggested From Diagnosis   | Diagnose tools for TenantLaunch Round2 5 | TenantLaunch Round2  | PASS   | 18.7s    | 799    | 4          | diagnose_project, read_topology, platform_context, agent_ops                     | yes      | 0         | -        | -     |
| 15  | Tool Suggested From Read Agent  | Read HumanOnboardingEscalation tool cont | TenantLaunch Round2  | PASS   | 11.1s    | 458    | 3          | read_agent, read_topology, platform_context                                      | yes      | 0         | -        | -     |
| 16  | Direct Tool Creation Assistance | Plan HTTP tool for IntegrationSetupSpeci | TenantLaunch Round2  | PASS   | 36.4s    | 25     | 7          | tools*ops, read_agent, read_topology, platform_context, variable_ops, find_tool* | yes      | 1         | -        | -     |
| 17  | Tool Auth Secret Chain          | Create auth-backed tool for IntegrationS | TenantLaunch Round2  | PASS   | 7.4s     | 79     | 2          | auth_ops, tools_ops, ask_user                                                    | yes      | 0         | -        | -     |
| 18  | Tool OAuth Callback Chain       | Plan OAuth callback tool for Integration | TenantLaunch Round2  | PASS   | 32.8s    | 29     | 9          | read_agent, read_topology, platform_context, tools_ops, find_tool_consumers, get | yes      | 1         | -        | -     |
| 19  | Tool Implied By Agent           | Agent creation implies appointment*slot* | CareTriage Round2 5- | PASS   | 43.5s    | 22     | 6          | read_topology, platform_context, propose_plan, propose_plan, propose_modificatio | yes      | 1         | -        | -     |
| 20  | Tool Suggested From Diagnosis   | Diagnose tools for CareTriage Round2 5-1 | CareTriage Round2 5- | PASS   | 19.2s    | 746    | 3          | read_topology, platform_context, diagnose_project                                | yes      | 0         | -        | -     |
| 21  | Tool Suggested From Read Agent  | Read AppointmentBooking tool context     | CareTriage Round2 5- | PASS   | 12.9s    | 544    | 3          | read_agent, read_topology, platform_context                                      | yes      | 0         | -        | -     |
| 22  | Direct Tool Creation Assistance | Plan HTTP tool for CareTriageRouter      | CareTriage Round2 5- | PASS   | 40.2s    | 620    | 8          | platform*context, tools_ops, read_agent, read_topology, variable_ops, find_tool* | yes      | 1         | -        | -     |
| 23  | Tool Auth Secret Chain          | Create auth-backed tool for CareTriageRo | CareTriage Round2 5- | PASS   | 10.3s    | 61     | 3          | platform_context, tools_ops, auth_ops, collect_secret                            | yes      | 0         | -        | -     |
| 24  | Tool OAuth Callback Chain       | Plan OAuth callback tool for CareTriageR | CareTriage Round2 5- | PASS   | 6.8s     | 9      | 2          | platform_context, tools_ops, ask_user                                            | yes      | 0         | -        | -     |
| 25  | Tool Implied By Agent           | Agent creation implies policy_article_se | CarrierCare Round2 5 | PASS   | 37.5s    | 24     | 8          | read_topology, platform_context, find_agent_refs, get_construct_spec, get_constr | yes      | 1         | -        | -     |
| 26  | Tool Suggested From Diagnosis   | Diagnose tools for CarrierCare Round2 5- | CarrierCare Round2 5 | PASS   | 14.9s    | 669    | 3          | read_topology, platform_context, diagnose_project                                | yes      | 0         | -        | -     |
| 27  | Tool Suggested From Read Agent  | Read BillingDisputeResolution tool conte | CarrierCare Round2 5 | PASS   | 10.7s    | 497    | 3          | read_agent, read_topology, platform_context                                      | yes      | 0         | -        | -     |
| 28  | Direct Tool Creation Assistance | Plan HTTP tool for CallerAuthentication  | CarrierCare Round2 5 | PASS   | 32.0s    | 28     | 8          | platform*context, tools_ops, read_agent, read_topology, variable_ops, find_tool* | yes      | 1         | -        | -     |
| 29  | Tool Auth Secret Chain          | Create auth-backed tool for CallerAuthen | CarrierCare Round2 5 | PASS   | 7.8s     | 48     | 3          | platform_context, tools_ops, auth_ops, collect_secret                            | yes      | 0         | -        | -     |
| 30  | Tool OAuth Callback Chain       | Plan OAuth callback tool for CallerAuthe | CarrierCare Round2 5 | PASS   | 37.4s    | 24     | 7          | platform_context, tools_ops, read_agent, read_topology, get_construct_spec, find | yes      | 1         | -        | -     |
