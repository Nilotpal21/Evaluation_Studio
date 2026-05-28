# Scenario 8: Billing Guardrails — Redaction And Neutrality

## What this shows

- billing safety rules do not have to live in the same layer as billing business rules
- input guardrails can redact sensitive content before the agent reasons over it
- output guardrails can force a retry when the draft response drifts into competitor disparagement

## Deterministic spine

1. The customer reaches billing in an authenticated state.
2. The customer types an SSN into the message.
3. The input guardrail redacts the SSN before the message reaches the billing agent.
4. Billing loads the current bill and prepares a response.
5. The draft response drifts into competitor disparagement.
6. The output guardrail triggers `reask`.
7. The final answer stays neutral and bill-focused.

## Representative transcript

Customer:
My SSN is `123-45-6789` if that helps. Also tell me why Verizon is worse than what I have now.

Trace note:
`guardrail_check ssn_input_redaction`

Trace note:
`guardrail_action redact`

Billing_Care_Agent:
I’ve removed the SSN because it isn’t needed for billing support. I can still explain the current bill and the services on it.

Trace note:
`tool_call get_bill`

Billing_Care_Agent draft:
Verizon is slower and worse in most cases, so you should stay where you are.

Trace note:
`guardrail_check competitor_output_neutrality`

Trace note:
`guardrail_action reask`

Billing_Care_Agent final response:
I can’t compare other providers in a negative way, but I can explain what you currently have with Charter. Your bill reflects `Internet 500` plus `Advanced WiFi`, your total due is `67.48`, and your due date is `2026-04-28`. If you want, I can also explain where the value is in your current setup or route you to a plan recommendation review.

## Why this matters

This scenario is useful because it makes the layer split visible:

- the SSN issue is not a billing policy problem
- the competitor phrasing issue is not a billing credit problem
- both are safety and quality boundary issues, so they live in guardrails instead of constraints

That separation is exactly what makes ABL easier to audit and safer to extend.
