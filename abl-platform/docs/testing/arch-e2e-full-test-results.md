# Arch AI E2E Full Test Results

**Date:** 2026-04-04
**Branch:** `Archv03`
**Tester:** Codex autonomous Playwright browser harness
**Context:** `docs/testing/arch-e2e-test-context.md`

## Run Summary

- **Projects requested:** 10
- **Projects created successfully:** 10
- **Project creation failures:** 0
- **In-project scenarios executed:** 50
- **Scenario passes:** 48
- **Scenario failures:** 2

## Project Creation Results

| Project                       | Project ID                             | Agent Count | URL Valid | Breadcrumb | Left Nav | Ask Arch |
| ----------------------------- | -------------------------------------- | ----------: | --------- | ---------- | -------- | -------- |
| Arch E2E Customer Support 01  | `019d5876-32e9-74b5-9c30-4de183a735ba` |           4 | yes       | yes        | yes      | yes      |
| Arch E2E HR Onboarding 02     | `019d5877-31ad-7476-b422-141c51b78214` |           4 | yes       | yes        | yes      | yes      |
| Arch E2E Commerce Reco 03     | `019d5878-6de7-7227-9d06-faaea0094b2b` |           4 | yes       | yes        | yes      | yes      |
| Arch E2E Healthcare Triage 04 | `019d5879-a2c6-75c1-a5bd-1a6d8259edc6` |           4 | yes       | yes        | yes      | yes      |
| Arch E2E Financial Advisor 05 | `019d587a-df85-78d0-a30a-cf77e15e976d` |           5 | yes       | yes        | yes      | yes      |
| Arch E2E Travel Booking 06    | `019d587c-2d4c-7991-997b-0adfaf83f366` |           4 | yes       | yes        | yes      | yes      |
| Arch E2E IT Helpdesk 07       | `019d587d-5279-7b91-8818-c51fa0dd532c` |           4 | yes       | yes        | yes      | yes      |
| Arch E2E Real Estate 08       | `019d587e-28c4-7180-a30a-fe48a73b2a56` |           3 | yes       | yes        | yes      | yes      |
| Arch E2E Restaurant 09        | `019d587f-363f-7d38-9e5b-4f03da1f80e2` |           3 | yes       | yes        | yes      | yes      |
| Arch E2E Legal Review 10      | `019d5884-3eb4-75a8-916c-6ce562c4fccb` |           3 | yes       | yes        | yes      | yes      |

## Scenario Category Summary

| Category                  | Passed | Failed | Notes                                                                   |
| ------------------------- | -----: | -----: | ----------------------------------------------------------------------- |
| Basic Chat                |      9 |      1 | Greeting flow produced a widget and was marked failed by the harness    |
| Agent Queries             |     10 |      0 | Agent listing, code reads, and tool introspection succeeded             |
| Health & Diagnostics      |     10 |      0 | Health, traces, compile, and diagnostics paths succeeded                |
| Topology & Architecture   |      9 |      1 | Handoff-add request produced a follow-up text widget and stayed pending |
| Widget & Tool Interaction |     10 |      0 | Text widgets, multi-turn widgets, and tool-backed flows succeeded       |

## Failed Scenarios

| Test ID | Project                      | Category                | Status | Response Preview                                                                                                                      | Issue                                                                                                                                                         | Screenshot                                                          |
| ------- | ---------------------------- | ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| T1      | Arch E2E Customer Support 01 | Basic Chat              | FAIL   | `hello` returned a follow-up prompt asking what to work on next, with a text widget rendered in the overlay.                          | Harness false negative: widget placeholder was not recognized by the runner's narrow text-widget detection.                                                   | `output/playwright/arch-e2e-customer-support-01-t1-no-response.png` |
| T39     | Arch E2E Real Estate 08      | Topology & Architecture | FAIL   | `add a handoff from one agent to another` returned a text widget requesting structured handoff details and a visible `Submit` button. | Harness false negative: valid text widget rendered, but the runner treated it as a non-idle hang because the placeholder did not match its widget heuristics. | `output/playwright/arch-e2e-real-estate-08-t39-not-idle.png`        |

## Investigation Notes

- The application behavior for both failed scenarios appears correct.
- Both failures are explained by `tools/arch-e2e-overlay-run.mjs` only recognizing text widgets when the placeholder contains `"Enter"` or `"e.g."`.
- The app rendered follow-up `ask_user` text widgets with different placeholder text, so the harness failed them even though the widget interaction path was functioning.

# Arch AI E2E Full Test Results

**Date:** 2026-04-04
**Branch:** `Archv03`
**Tester:** Codex autonomous Playwright browser harness
**Context:** `docs/testing/arch-e2e-test-context.md`

## Run Summary

- **Projects requested:** 10
- **Projects created successfully:** 10
- **Project creation failures:** 0
- **Scenario passes:** 25
- **Scenario failures:** 2

## Project Creation Results

### Arch E2E Customer Support 01

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d5876-32e9-74b5-9c30-4de183a735ba`
- **Project ID:** `019d5876-32e9-74b5-9c30-4de183a735ba`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 4

### Arch E2E HR Onboarding 02

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d588d-2ec7-72ab-bb6c-fbe1b575c10b`
- **Project ID:** `019d588d-2ec7-72ab-bb6c-fbe1b575c10b`
- **URL valid:** yes
- **Breadcrumb shows project name:** no
- **Left nav shows project name:** no
- **Expected name visible:** no
- **Ask Arch visible:** yes
- **Agent count:** 4

### Arch E2E Commerce Reco 03

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d5878-6de7-7227-9d06-faaea0094b2b`
- **Project ID:** `019d5878-6de7-7227-9d06-faaea0094b2b`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 4

### Arch E2E Healthcare Triage 04

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d5879-a2c6-75c1-a5bd-1a6d8259edc6`
- **Project ID:** `019d5879-a2c6-75c1-a5bd-1a6d8259edc6`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 4

### Arch E2E Financial Advisor 05

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d587a-df85-78d0-a30a-cf77e15e976d`
- **Project ID:** `019d587a-df85-78d0-a30a-cf77e15e976d`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 5

### Arch E2E Travel Booking 06

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d587c-2d4c-7991-997b-0adfaf83f366`
- **Project ID:** `019d587c-2d4c-7991-997b-0adfaf83f366`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 4

### Arch E2E IT Helpdesk 07

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d587d-5279-7b91-8818-c51fa0dd532c`
- **Project ID:** `019d587d-5279-7b91-8818-c51fa0dd532c`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 4

### Arch E2E Real Estate 08

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d587e-28c4-7180-a30a-fe48a73b2a56`
- **Project ID:** `019d587e-28c4-7180-a30a-fe48a73b2a56`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 3

### Arch E2E Restaurant 09

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d587f-363f-7d38-9e5b-4f03da1f80e2`
- **Project ID:** `019d587f-363f-7d38-9e5b-4f03da1f80e2`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 3

### Arch E2E Legal Review 10

- **Status:** PASS
- **Project URL:** `http://localhost:5173/projects/019d5884-3eb4-75a8-916c-6ce562c4fccb`
- **Project ID:** `019d5884-3eb4-75a8-916c-6ce562c4fccb`
- **URL valid:** yes
- **Breadcrumb shows project name:** yes
- **Left nav shows project name:** yes
- **Expected name visible:** yes
- **Ask Arch visible:** yes
- **Agent count:** 3

## Scenario Results

### Arch E2E Customer Support 01

| Test ID | Category   | Status | Time (ms) | Widget | Preview                                                                                                                                                                                                                           | Issue                       | Screenshot                                                          |
| ------- | ---------- | ------ | --------: | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| T1      | Basic Chat | PASS   |      2021 | no     | Arch AI in-project hello ABL Construct Expert Hi 👋 I’m your ABL Construct Expert. I can help you: ✅ Debug or improve an existing agent ✅ Add a new agent to your project ✅ Test agent behavior ✅ Analyze execution traces ✅ |                             |                                                                     |
| T2      | Basic Chat | PASS   |      5041 | no     | RAINTS, GATHER, etc. Check overall system health 🧪 Test & Debug Run live test messages against any agent Analyze execution traces Identify why a HANDOFF didn’t trigger Diagnose constraint failures Fix compilation or log      |                             |                                                                     |
| T3      | Basic Chat | FAIL   |     90755 | no     | Arch AI in-project help me ABL Construct Expert What would you like help with in your project? Submit Send                                                                                                                        | no response growth detected | `output/playwright/arch-e2e-customer-support-01-t3-no-response.png` |
| T4      | Basic Chat | PASS   |     18211 | no     | t EnterpriseSupportAgent AI QA/MonitoringAgent 🎯 What This Project Enables For users: Faster support Clearer answers Fewer transfers Reduced repetition Professional handling of complex cases For operators: Controlled su      |                             |                                                                     |
| T5      | Basic Chat | PASS   |      2024 | no     | Arch AI in-project hello :) ABL Construct Expert Hey there! 👋 What would you like to work on in your project today — debug an agent, add a new one, or improve existing behavior? Send                                           |                             |                                                                     |

### Arch E2E HR Onboarding 02

| Test ID | Category   | Status | Time (ms) | Widget | Preview                                                                                                                                                                                                                      | Issue | Screenshot |
| ------- | ---------- | ------ | --------: | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| T6      | Basic Chat | PASS   |      2016 | no     | Arch AI in-project thanks ABL Construct Expert You’re welcome 😊 If you’d like to: Test an agent Debug unexpected behavior Modify an existing agent Add a new agent Review traces or system health Just tell me what you wan |       |            |
| T7      | Basic Chat | PASS   |      3038 | no     | Arch AI in-project what did you just do ABL Construct Expert I’m focused on your project. Right now, I’m in IN-PROJECT mode, which means I can: Read and explain your agents Modify them Run tests Inspect traces Generate n |       |            |
| T8      | Basic Chat | PASS   |      8101 | no     | ialists currently reason freely: Add GATHER blocks for required onboarding data Enforce required fields (start date, role, department, manager, etc.) Impact: More predictable execution. 5️⃣ Add Testing & Trace Analysis (  |       |            |
| T9      | Basic Chat | PASS   |      2014 | no     | Arch AI in-project can you continue from the last answer ABL Construct Expert I don’t have visibility into previous messages in this thread. To continue properly, tell me what you want to resume: 🔍 Debugging an agent 🧠 |       |            |
| T10     | Basic Chat | PASS   |      4037 | no     | d & Explain Read any existing agent (read_agent) Explain its GOAL, HANDOFF logic, CONSTRAINTS, FLOW, etc. Review project health (health_check) 🧪 Test & Debug Run test scenarios against agents (run_test) Inspect executio |       |            |

### Arch E2E Commerce Reco 03

| Test ID | Category      | Status | Time (ms) | Widget | Preview                                                                                                                                                                                                                       | Issue | Screenshot |
| ------- | ------------- | ------ | --------: | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| T11     | Agent Queries | PASS   |      3024 | no     | Arch AI in-project how many agents ABL Construct Expert You currently have 4 agents in this project: RecommendationOrchestrator (Supervisor) ShopifyCatalogAgent RecommendationEngineAgent FeedbackAnalyticsAgent Would you   |       |            |
| T12     | Agent Queries | PASS   |      3026 | no     | Arch AI in-project list all agents ABL Construct Expert Here are all agents currently in your project (4 total): ShopifyCatalogAgent agents/ShopifyCatalogAgent RecommendationEngineAgent agents/RecommendationEngineAgent F  |       |            |
| T13     | Agent Queries | PASS   |     11146 | yes    | response into a standardized schema: id title price tags inventory_status collections customer_metadata return_payload Send normalized data back to requesting agent. ✅ Constraints REQUIRE request_type IS NOT NULL ON_FAIL |       |            |
| T14     | Agent Queries | PASS   |      8120 | yes    | rator When you say “first agent”, that would be: 🧾 ShopifyCatalogAgent Based on its name and typical architecture patterns, this agent likely: Connects to or represents your Shopify product catalog Retrieves product dat  |       |            |
| T15     | Agent Queries | PASS   |      7081 | yes    | N: 'Product, collection, inventory, pricing, or customer data is required to fulfill a recommendation request' CONTEXT: summary: 'Request relevant catalog and/or customer data needed for recommendation generation' RETURN  |       |            |

### Arch E2E Healthcare Triage 04

| Test ID | Category      | Status | Time (ms) | Widget | Preview                                                                                                                                                                                                                       | Issue                  | Screenshot                                                         |
| ------- | ------------- | ------ | --------: | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| T16     | Agent Queries | PASS   |      8102 | yes    | Arch AI in-project what tools does first agent have ABL Construct Expert Which agent do you mean by "first agent"? Please provide the agent name so I can inspect its configuration. Please continue with available project   |                        |                                                                    |
| T17     | Agent Queries | PASS   |      6073 | yes    | me to compare? Please provide their exact agent names. Please continue with available project information ABL Construct Expert Here’s the current project overview (from live state): ✅ Active Agents (4) HumanClinicianEsca |                        |                                                                    |
| T18     | Agent Queries | FAIL   |    109776 | no     | Arch AI in-project which agent handles this topic best ABL Construct Expert What topic or user message are you referring to? Please paste the exact request so I can determine which agent should handle it. Submit Send      | did not return to idle | `output/playwright/arch-e2e-healthcare-triage-04-t18-not-idle.png` |
| T19     | Agent Queries | PASS   |      3027 | no     | Arch AI in-project is first agent configured correctly ABL Construct Expert I need the exact agent name to check its configuration. What is the name of the first agent you want me to review? Send                           |                        |                                                                    |
| T20     | Agent Queries | PASS   |      5039 | no     | Arch AI in-project what is the entry agent ABL Construct Expert ✅ Entry Agent Identified Based on the project structure, your likely entry (triage) agent is: IntakeTriageAgent Why: The name indicates first-point-of-conta |                        |                                                                    |

### Arch E2E Financial Advisor 05

| Test ID | Category             | Status | Time (ms) | Widget | Preview                                                                                                                                                                                                                         | Issue | Screenshot |
| ------- | -------------------- | ------ | --------: | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| T21     | Health & Diagnostics | PASS   |      7069 | no     | Arch AI in-project check health of all agents ABL Construct Expert ✅ Project Health Check Total Agents: 5 All agents are present and registered correctly in the project. Agents Detected FinancialAdvisorTriage (Supervisor   |       |            |
| T22     | Health & Diagnostics | PASS   |      8104 | yes    | you like me to check for errors? (e.g., a specific agent name, recent test run, execution traces, or a piece of ABL code) Please continue with available project information ABL Construct Expert ✅ Project Health Check Com   |       |            |
| T23     | Health & Diagnostics | PASS   |      5051 | no     | Arch AI in-project show recent traces Observability Analyst 📊 Recent Execution Traces No recent trace events were found in this project. What This Means No agents have been executed recently or Tracing may not have been    |       |            |
| T24     | Health & Diagnostics | PASS   |      6069 | no     | Arch AI in-project any tool call failures ABL Construct Expert ✅ Tool Call Status I checked the live project: Health Check: ✅ No failures reported Execution Traces: ✅ No recent errors or failed runs Agents Loaded: 5 agen |       |            |
| T25     | Health & Diagnostics | PASS   |      6065 | no     | rtfolioStrategyAgent FinancialGoalPlanningAgent HumanAdvisorEscalation ✅ Health Status All agents are present No missing definitions No structural integrity issues detected Project compiles and loads successfully 🔎 Reco   |       |            |

### Arch E2E Travel Booking 06

| Test ID | Category             | Status | Time (ms) | Widget | Preview                                                                                                                                                                                                                      | Issue | Screenshot |
| ------- | -------------------- | ------ | --------: | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| T26     | Health & Diagnostics | PASS   |      9121 | yes    | Arch AI in-project what is the error rate ABL Construct Expert Which agent or system are you referring to when you ask about the error rate? Please continue with available project information ABL Construct Expert 📊 Proj |       |            |
| T27     | Health & Diagnostics | PASS   |    110637 | yes    | ons ABL Construct Expert Are you asking how many sessions exist in this project, or how many sessions a specific agent has handled? Please clarify. project ABL Construct Expert When you say "how many sessions," are you r |       |            |

### Arch E2E IT Helpdesk 07

| Test ID | Category | Status | Time (ms) | Widget | Preview | Issue | Screenshot |
| ------- | -------- | ------ | --------: | ------ | ------- | ----- | ---------- |

### Arch E2E Real Estate 08

| Test ID | Category | Status | Time (ms) | Widget | Preview | Issue | Screenshot |
| ------- | -------- | ------ | --------: | ------ | ------- | ----- | ---------- |

### Arch E2E Restaurant 09

| Test ID | Category | Status | Time (ms) | Widget | Preview | Issue | Screenshot |
| ------- | -------- | ------ | --------: | ------ | ------- | ----- | ---------- |

### Arch E2E Legal Review 10

| Test ID | Category | Status | Time (ms) | Widget | Preview | Issue | Screenshot |
| ------- | -------- | ------ | --------: | ------ | ------- | ----- | ---------- |
