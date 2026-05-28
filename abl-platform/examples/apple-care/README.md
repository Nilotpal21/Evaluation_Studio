# Apple Care Support

Multi-agent Apple customer care system for device support, account help, repairs, warranty, and subscription management. Features multi-channel templates (SDK, Markdown, HTML, Voice) for consistent experiences across chat, web, and IVR.

## Architecture

```
Apple_Care_Supervisor (Orchestrator)
├── Device_Support          — iPhone, iPad, Mac, Apple Watch, AirPods troubleshooting
├── Account_Support         — Apple ID, iCloud, 2FA, account security
├── Repair_And_Warranty     — Warranty checks, in-store service, mail-in repairs
├── Subscription_Support    — Apple One, Music, TV+, Arcade, iCloud+, News+, Fitness+
└── Live_Agent              — Human specialist escalation with full context
```

The supervisor routes by intent category with priority ordering: human escalation (P1), device issues (P2), account (P3), repairs (P4), subscriptions (P5).

## Environment Variables

No environment variables are required. Tools use inline definitions.

## Import

```bash
abl import ./examples/apple-care
```

## Directory Structure

```
apple-care/
  project.json                              — v2 project manifest
  agents/
    apple_care_supervisor.agent.abl         — Supervisor/orchestrator
    device_support.agent.abl                — Device troubleshooting agent
    account_support.agent.abl               — Apple ID/iCloud agent
    repair_and_warranty.agent.abl           — Repair and warranty agent
    subscription_support.agent.abl          — Subscription management agent
    live_agent.agent.abl                    — Human escalation agent
  tools/
    device_diagnostics.tools.abl            — Device diagnostic tools
    account_management.tools.abl            — Account management tools
    repair_and_warranty.tools.abl           — Repair and warranty tools
    subscription_management.tools.abl       — Subscription tools
  config/
    project-settings.json                   — Runtime configuration
  environment/
    env-vars.json                           — Environment variables (none required)
  locales/
    en/                                     — English locale strings per agent
```
