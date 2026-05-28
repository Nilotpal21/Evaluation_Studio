# Telco NOC Platform

AI-powered Network Operations Center with multi-agent orchestration for alarm triage, link diagnostics, capacity planning, incident management, maintenance scheduling, and OS upgrade coordination.

## Architecture

```
NOC_Supervisor (Orchestrator)
├── Network_Triage          — First-line alarm assessment and classification
├── Link_Analyzer           — Fiber/transport link diagnostics (OTDR, BER)
├── Capacity_Planner        — Traffic analytics and capacity forecasting
├── Maintenance_Scheduler   — Predictive maintenance and spare parts management
├── Incident_Manager        — Incident lifecycle, RCA, and SLA tracking
└── OS_Upgrade_Coordinator  — Canary deployment OS upgrades with rollback
```

All alarms flow through Network_Triage before routing to specialist agents. The NOC_Supervisor enforces SLA compliance and escalation policies.

## Environment Variables

| Variable               | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `NOC_API_BASE_URL`     | Base URL for the NOC tools API (default: `http://localhost:4100/api/tools`) |
| `NOC_API_BEARER_TOKEN` | Bearer token for authenticating with the NOC tools API                      |

## Import

```bash
abl import ./examples/telco
```

The `project.json` manifest defines all agents, tools, and metadata in v2 export format.

## Directory Structure

```
telco/
  project.json                          — v2 project manifest
  agents/
    noc_supervisor.agent.abl            — Supervisor/orchestrator
    network_triage.agent.abl            — L1 triage agent
    link_analyzer.agent.abl             — Link diagnostics specialist
    capacity_planner.agent.abl          — Capacity planning specialist
    maintenance_scheduler.agent.abl     — Maintenance scheduling specialist
    incident_manager.agent.abl          — Incident management specialist
    os_upgrade_coordinator.agent.abl    — OS upgrade specialist
  tools/
    noc_dashboard.tools.abl             — Dashboard and alarm tools
    site_inventory.tools.abl            — Site inventory tools
    link_diagnostics.tools.abl          — Link diagnostic tools
    capacity_planning.tools.abl         — Capacity planning tools
    maintenance.tools.abl               — Maintenance tools
    incident_management.tools.abl       — Incident management tools
    os_upgrade.tools.abl                — OS upgrade tools
  config/
    project-settings.json               — Runtime configuration
  environment/
    env-vars.json                       — Required environment variables
  locales/
    en/                                 — English locale strings per agent
```
