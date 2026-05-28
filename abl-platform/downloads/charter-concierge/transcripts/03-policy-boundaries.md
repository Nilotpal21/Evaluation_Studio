# Scenario 3: Policy Explanation Without Blurring Hard Boundaries

## What this shows

- reasoning can explain a hard telecom rule in plain language
- deterministic boundaries still remain explicit
- policy explanation is different from policy override

## Deterministic spine

1. The supervisor routes the request to `Policy_Advisor`.
2. `Policy_Advisor` gathers the topic.
3. `lookup_service_policy` returns a deterministic explanation payload.
4. The agent explains the rationale without weakening the boundary.

## Representative transcript

Customer:
Why can’t you help with a SIM or port change if the customer is not verified yet?

Supervisor:
I will route that to policy so you get the rule and the rationale clearly.

Trace note:
`handoff -> Policy_Advisor`

Policy_Advisor:
The policy topic here is identity verification. I am pulling the explanation now.

Trace note:
`tool_call lookup_service_policy`

Policy_Advisor:
Here is the plain-language version:

- sensitive mobile and account actions require a verified customer state before self-service can proceed
- the reason is fraud prevention, not arbitrary gatekeeping
- the hard boundary is that I can explain the rule, but I cannot bypass verification or downgrade the request into a low-risk path

If you want a live review path, I can route you to support, but I cannot self-authorize the exception here.

## Fixed tool output

```json
{
  "topic": "identity verification",
  "policy": "Sensitive mobile and account actions require a verified customer state before self-service can proceed.",
  "rationale": "SIM changes, ports, and other account-sensitive actions create fraud risk when identity is uncertain.",
  "deterministic_boundary": "The assistant cannot bypass verification or reclassify a sensitive request as low-risk."
}
```

## Why this matters

This scenario shows that "reasoning-heavy" does not mean "soft on rules."

The model gets freedom in explanation style, but not freedom to redefine the deterministic boundary.
