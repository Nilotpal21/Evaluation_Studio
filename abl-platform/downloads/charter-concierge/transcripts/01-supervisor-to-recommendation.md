# Scenario 1: Supervisor Handoff Plus Hidden Recommendation Delegate

## What this shows

- the supervisor owns top-level routing
- `HANDOFF` changes the visible specialist
- `DELEGATE` runs a bounded subroutine without changing the visible speaker
- deterministic recommendation pricing can live inside a reasoning-led intake flow

## Deterministic spine

1. `Charter_Concierge_Supervisor` hands off to `Charter_Intake_Agent`.
2. Intake checks risk and service offers.
3. The customer chooses an offer.
4. Intake delegates structured recommendation pricing to `Offer_Analyst`.
5. `Offer_Analyst` runs a deterministic flow and tool call.
6. The recommendation returns to intake without a visible speaker change.

## Representative transcript

Customer:
I’m moving to 400 Washington Blvd in Stamford and want home internet plus two mobile lines. Heavy WiFi use, lots of devices.

Supervisor:
I can route that to service intake so they can narrow the best Spectrum-style offer and build a structured recommendation.

Trace note:
`decision -> handoff -> agent_switch`

Charter_Intake_Agent:
Understood. I have:

- service address: `400 Washington Blvd, Stamford, CT`
- need: heavy home WiFi
- mobile lines: `2`
- bundle interest: internet + mobile

I am checking deterministic risk and available offers now.

Trace note:
`tool_call assess_request_risk`

Trace note:
`tool_call search_service_offers`

Charter_Intake_Agent:
Your request clears the deterministic risk screen.

I found these candidate offers:

1. `SP1-300-1L` - Spectrum One 300 + 1 Unlimited Line - estimated `55/month`
2. `SP1-GIG-2L` - Spectrum One Gig + 2 Unlimited Lines - estimated `95/month`
3. `INT-500-WIFI` - Internet 500 + Advanced WiFi - estimated `70/month`

The recommended offer is `SP1-GIG-2L` because the request combines high WiFi demand with two mobile lines.

Customer:
Use `SP1-GIG-2L`.

Trace note:
`delegate_start -> Offer_Analyst`

Offer_Analyst:
Collecting the selected offer, mobile lines, WiFi fit, and TV interest from the parent context.

Trace note:
`flow_step collect_inputs -> build_recommendation`

Trace note:
`tool_call create_plan_recommendation`

Offer_Analyst:
The deterministic recommendation is ready. Returning structured pricing data to intake.

Trace note:
`delegate_complete -> return_to_parent`

Charter_Intake_Agent:
Your recommendation is ready.

- plan id: `PLAN-SP1-GIG-2L`
- monthly total: `95`
- install fee: `30`
- manual review required: `no`

The next deterministic step is setup readiness.

## Fixed tool outputs

### `assess_request_risk`

```json
{
  "allowed": true,
  "risk_level": "low",
  "requires_human_review": false,
  "notes": ["No deterministic fraud or support-lane flags were triggered."]
}
```

### `search_service_offers`

```json
{
  "status": "offers_ready",
  "market": "CT",
  "recommended_offer_id": "SP1-GIG-2L",
  "requires_human_review": false,
  "serviceable": true
}
```

### `create_plan_recommendation`

```json
{
  "status": "ok",
  "plan_id": "PLAN-SP1-GIG-2L",
  "monthly_total": 95,
  "install_fee": 30,
  "requires_manual_review": false
}
```

## Why this matters

This is the cleanest example of why `HANDOFF` and `DELEGATE` should not be merged.

- The supervisor really does transfer ownership to intake.
- Intake really does stay the visible owner while structured pricing happens underneath.
