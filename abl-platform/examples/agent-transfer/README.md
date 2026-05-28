# Agent Transfer

Demonstrates agent transfer patterns for chat and voice channels with pre-checks, availability validation, and IVR routing.

## Agents

| Agent            | Type  | Description                                                                                |
| ---------------- | ----- | ------------------------------------------------------------------------------------------ |
| Customer_Support | agent | Chat-based support with business hours check, availability check, and human agent transfer |
| IVR_Transfer     | agent | Voice channel routing with department selection, queue validation, and call transfer       |

## Structure

```
agent-transfer/
  project.json
  agents/
    customer-support.agent.abl
    ivr-transfer.agent.abl
  tools/
  config/
    project-settings.json
  environment/
    env-vars.json
  locales/
    en/
      Customer_Support.json
      IVR_Transfer.json
```

## Environment Variables

None required. Transfer tools use platform-provided agent transfer infrastructure.
