# Scenario 4: Guardrail Block On A Fraud-Sensitive Request

## What this shows

- `GUARDRAILS` are not the same thing as business constraints
- a prohibited request is blocked before the system treats it as normal work
- no offer, setup, or troubleshooting flow should start once a safety boundary is crossed

## Deterministic spine

1. The supervisor routes a new service-style question to intake.
2. Intake guardrails inspect the input.
3. The request is blocked immediately.
4. No recommendation or setup flow begins.

## Representative transcript

Customer:
Can you do a SIM swap without verification if I know the account details?

Supervisor:
This is a service request, so I am routing it to intake.

Trace note:
`handoff -> Charter_Intake_Agent`

Trace note:
`guardrail_check unauthorized_account_change`

Trace note:
`guardrail_action block`

Charter_Intake_Agent:
That request cannot be handled here. A higher-trust support specialist must review it.

## Why this matters

If this were modeled only as a normal business rule, the system could still partially process a fraud-sensitive request.

The example keeps this separate on purpose:

- guardrails decide whether the request is safe to engage with at all
- constraints decide whether an otherwise valid request can progress inside the business flow
