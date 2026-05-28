# Scenario 5: Current Service Advice Plus Material Change Routing

## What this shows

- deterministic current-service retrieval and reasoning can coexist in one specialist
- not every service question requires a fresh recommendation
- material service changes can still be routed back into intake explicitly

## Deterministic spine

1. The supervisor hands off to `Connectivity_Advisor`.
2. `get_service_brief` returns the current structured service brief.
3. The advisor answers a non-material question directly.
4. A material change request triggers a `HANDOFF` back to intake.

## Representative transcript

Customer:
For `PLAN-SP1-GIG-2L`, what should we keep in mind about WiFi fit and next steps?

Supervisor:
I am routing you to connectivity advice.

Trace note:
`handoff -> Connectivity_Advisor`

Trace note:
`tool_call get_service_brief`

Connectivity_Advisor:
For `PLAN-SP1-GIG-2L`, the current brief says:

- gig internet plus Advanced WiFi plus two mobile lines
- the recommendation assumed a high-capacity home connectivity profile
- setup readiness, modem state, and material plan changes are the next key boundaries

Customer:
What if we drop one line and switch back to a lighter plan?

Connectivity_Advisor:
That is a material change because it affects the bundle shape and recommendation math. I can preserve the current context, but intake should own the refreshed recommendation path.

Trace note:
`handoff -> Charter_Intake_Agent`

Charter_Intake_Agent:
I have the current plan context and the requested change. I will treat this as a refreshed recommendation request.

## Fixed tool output

```json
{
  "brief": "Gig internet, Advanced WiFi, and two mobile lines with a high-capacity home connectivity profile.",
  "outage_note": "No specific outage is modeled in the demo; use the brief for current-service explanation only.",
  "device_note": "Advanced WiFi fit is important because the recommendation assumed many devices or heavy usage.",
  "next_actions": [
    "Verify setup readiness",
    "Confirm modem state",
    "Route material plan changes back to intake"
  ]
}
```

## Why this matters

This is the "deterministic plus reasoning together" story in one place.

- the current service brief is deterministic
- the explanation is natural language
- the recommendation-refresh boundary is explicit and authored
