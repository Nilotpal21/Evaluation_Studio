# Healthcare Payer — Provider Portal

## Overview

AI-powered provider portal for healthcare payer operations. Providers (doctors,
clinics, facilities) authenticate and then query member plan information,
coverage/eligibility details, and claim status on behalf of their patients.

**Source:** Converted from a Kore AI Agentic export using a front-desk
**supervisor + handoff** pattern.

## Project Structure

```
ai4hc-payer/
├── agents/
│   ├── welcome_agent.agent.abl            # Supervisor entry point — greetings, intent routing
│   ├── authentication_agent.agent.abl     # Provider ID / NPI verification
│   ├── plan_information_agent.agent.abl   # Plan details (deductibles, OOP, dates)
│   ├── coverage_information_agent.agent.abl  # Coverage & eligibility (copay, prior auth)
│   ├── claim_information_agent.agent.abl  # Claim status, payments, filtering
│   └── human_agent.agent.abl              # Human escalation placeholder
├── tools/
│   ├── authentication.tools.abl           # perform_provider_authentication
│   ├── plans.tools.abl                    # get_plan_information
│   ├── claims.tools.abl                   # get_claim_information
│   └── coverage.tools.abl                # search_coverage_kb
├── config/                                # Agent/system configuration (future)
├── connections/                           # Data source connectors (future)
├── guardrails/                            # Safety and compliance rules (future)
├── workflows/                             # Multi-agent orchestrations (future)
├── project.json                           # Project metadata and manifest
└── spec.md                                # This file
```

## Architecture

```
                 ┌───────────────────┐
                 │   Welcome_Agent   │  ← entry point
                 │  (greetings/help) │
                 └────────┬──────────┘
                          │ HANDOFF (based on intent + auth status)
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
 ┌─────────────┐  ┌──────────────┐  ┌──────────────┐
 │    Plan      │  │  Coverage    │  │    Claim     │
 │ Information  │  │ Information  │  │ Information  │
 │    Agent     │  │    Agent     │  │    Agent     │
 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
        │                 │                  │
        │  HANDOFF if not authenticated      │
        └─────────────────┼──────────────────┘
                          ▼
                 ┌────────────────────┐
                 │ Authentication     │
                 │      Agent         │
                 │ (Provider ID/NPI)  │
                 └────────────────────┘
```

### Pattern: Supervisor / Handoff

Welcome_Agent is the central supervisor for the provider portal:

- **Welcome_Agent** is the entry point — greets, detects intent, and hands off
  to the right domain agent or to Authentication_Agent when the provider is not
  yet authenticated.
- **Authentication_Agent** collects Provider ID (9 digits) or NPI ID (10 digits),
  validates, and stores credentials in session memory. After successful auth it
  hands off to the domain agent matching the provider's original intent.
- **Domain agents** (Plan, Coverage, Claim) each carry an auth gate — if the
  provider is not authenticated they hand off to Authentication_Agent. Otherwise
  they collect Member ID and call their respective tools.

### Agents

| Agent                        | Purpose                                               |
| ---------------------------- | ----------------------------------------------------- |
| `Welcome_Agent`              | Front-desk: greetings, help menu, intent routing      |
| `Authentication_Agent`       | Provider authentication via Provider ID or NPI ID     |
| `Plan_Information_Agent`     | Member plan details (deductibles, OOP, dates, status) |
| `Coverage_Information_Agent` | Service eligibility, copay, coinsurance, prior auth   |
| `Claim_Information_Agent`    | Claim status, payment details, filtering              |
| `Human_Agent`                | Escalation placeholder for human assistance           |

### Tools

| Tool                              | File                       | Type    | Description                                        |
| --------------------------------- | -------------------------- | ------- | -------------------------------------------------- |
| `perform_provider_authentication` | `authentication.tools.abl` | Sandbox | Validates Provider ID / NPI ID against provider DB |
| `get_plan_information`            | `plans.tools.abl`          | Sandbox | Retrieves plan details for a given Member ID       |
| `get_claim_information`           | `claims.tools.abl`         | Sandbox | Retrieves claims for a Member ID (with filters)    |
| `search_coverage_kb`              | `coverage.tools.abl`       | Sandbox | Queries Plan Services Coverage knowledge base      |

### Memory

| Store           | Scope   | Key Fields                                                        |
| --------------- | ------- | ----------------------------------------------------------------- |
| `provider_data` | Session | providerId, npiId, taxonomyCode, medicaidId, zipCode, auth status |

### Events

| Event               | Trigger                                |
| ------------------- | -------------------------------------- |
| Welcome             | Session start                          |
| Agent Handoff       | Provider requests human agent          |
| End of Conversation | Provider says goodbye / task completed |
