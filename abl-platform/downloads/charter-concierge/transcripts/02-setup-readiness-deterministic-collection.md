# Scenario 2: Deterministic Setup Readiness Collection

## What this shows

- `ENTITIES` normalize fuzzy setup language into stable values
- `ENTITY_REF` lets `GATHER` commit those values into state
- setup readiness is deterministic, not improvised by the model
- the system can explain exactly why progress is blocked

## Deterministic spine

1. The supervisor hands off to `Setup_Readiness_Collector`.
2. The collector gathers operational basics.
3. Entity-backed fields normalize informal language.
4. `validate_setup_readiness` decides readiness.
5. The flow returns the missing items explicitly.

## Representative transcript

Customer:
Let’s do setup readiness for the selected plan.

Supervisor:
I am routing you to setup readiness so installation and activation can be checked deterministically.

Trace note:
`handoff -> Setup_Readiness_Collector`

Setup_Readiness_Collector:
I need the minimum setup inputs in a fixed order.

What is the service address?

Customer:
400 Washington Blvd, Stamford, CT.

Setup_Readiness_Collector:
How many services are in the selected plan?

Customer:
Three.

Setup_Readiness_Collector:
How many mobile lines are included?

Customer:
Two.

Setup_Readiness_Collector:
What contact number should support use?

Customer:
`+1-203-555-0184`

Setup_Readiness_Collector:
Is the address verified for service?

Customer:
Yes, verified.

Setup_Readiness_Collector:
What is the modem or router status?

Customer:
We still need equipment shipped.

Setup_Readiness_Collector:
What is the mobile device activation status?

Customer:
Still picking phones, not sure yet.

Trace note:
`entity_resolved address_status -> ADDR_VERIFIED`

Trace note:
`entity_resolved modem_status -> MODEM_NEEDS_SHIPMENT`

Trace note:
`entity_resolved device_status -> DEVICE_UNKNOWN`

Trace note:
`tool_call validate_setup_readiness`

Setup_Readiness_Collector:
Setup readiness is blocked.

I am missing:

- ready modem or router state
- mobile device activation state

Once those are clarified, I can run the readiness check again without changing anything else.

## Fixed tool outputs

### Entity normalization

```json
{
  "address_status": "ADDR_VERIFIED",
  "modem_status": "MODEM_NEEDS_SHIPMENT",
  "device_status": "DEVICE_UNKNOWN"
}
```

### `validate_setup_readiness`

```json
{
  "status": "needs_follow_up",
  "ready": false,
  "missing_items": ["ready modem or router state", "mobile device activation state"],
  "summary": "The selected plan still has setup gaps that block deterministic readiness.",
  "requires_human_review": false
}
```

## Why this matters

The assistant is not being vague or evasive. It is following a deterministic operational contract:

- verified address helps
- equipment not ready blocks readiness
- unknown device activation state blocks readiness when mobile lines are included
