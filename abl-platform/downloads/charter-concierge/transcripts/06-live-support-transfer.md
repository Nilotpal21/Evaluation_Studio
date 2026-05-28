# Scenario 6: Live Support Transfer And Callback Scheduling

## What this shows

- deterministic rules can route work to humans cleanly
- escalation is still an authored orchestration path, not just a failure case
- the human handoff can itself be a deterministic flow

## Deterministic spine

1. The supervisor routes a request to intake.
2. Intake sees a higher-touch or higher-risk support pattern.
3. Intake hands off to `Human_Support_Transfer`.
4. The transfer agent gathers callback details.
5. `schedule_support_callback` creates a deterministic callback ticket.

## Representative transcript

Customer:
I need a same-day install, and I also want to port two numbers even though the account owner is not available to verify yet.

Supervisor:
I am routing this to service intake.

Trace note:
`handoff -> Charter_Intake_Agent`

Charter_Intake_Agent:
I am checking the support lane, but this is likely to require live help because it combines same-day install pressure with a sensitive mobile action.

Trace note:
`tool_call assess_request_risk`

Charter_Intake_Agent:
This request needs live support review.

The deterministic reasons are:

- same-day install requests require live support confirmation
- port-related actions need a verified customer state

I am handing you to live support transfer now.

Trace note:
`handoff -> Human_Support_Transfer`

Human_Support_Transfer:
I can schedule a live callback. Who should support contact?

Customer:
Jordan Price.

Human_Support_Transfer:
What number should support use?

Customer:
`+1-917-555-0142`

Human_Support_Transfer:
What callback window do you prefer?

Customer:
Within 30 minutes.

Trace note:
`tool_call schedule_support_callback`

Human_Support_Transfer:
Your live support callback is scheduled.

- ticket: `SUP-6221`
- queue: `activation_support`
- callback window: `within 30 minutes`

## Fixed tool outputs

### `assess_request_risk`

```json
{
  "allowed": true,
  "risk_level": "high",
  "requires_human_review": true,
  "notes": [
    "Sensitive mobile changes require a verified customer state.",
    "Same-day install requests require live support confirmation."
  ]
}
```

### `schedule_support_callback`

```json
{
  "status": "scheduled",
  "callback_window": "within 30 minutes",
  "ticket_id": "SUP-6221",
  "queue": "activation_support"
}
```

## Why this matters

This is not the system giving up.

It is the system following an explicit, traceable escalation path where the AI stays useful, the human boundary is clear, and the callback workflow is still deterministic.
