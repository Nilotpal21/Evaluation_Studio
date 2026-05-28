# Dispute Transaction

A comprehensive multi-agent system for handling credit/debit card transaction disputes in financial services.

## Overview

This example demonstrates a production-grade dispute resolution workflow inspired by enterprise banking virtual assistants. It showcases:

- **Multi-agent orchestration** with a supervisor coordinating specialized agents
- **Channel-specific routing** (Web vs IVR/Voice)
- **Intelligent validation** through probing questions and pattern analysis
- **Reason-specific workflows** with different data collection paths
- **Authentication integration** for secure dispute filing
- **Escalation handling** to human agents when needed

## Architecture

```
DisputeTransaction_Supervisor (Orchestrator)
├── Dispute                 — End-to-end dispute processing (intake, validation, collection, confirmation)
├── Agent_Transfer          — Escalation to human agents
└── Feedback_Agent          — Post-resolution feedback collection
```

### Workflow Stages

1. **Authentication** - Verify user identity before proceeding
2. **Initial Capture** - Dispute reason and card selection
3. **Transaction Selection** - Identify specific transaction(s)
4. **Validation** - Probing questions for unrecognized charges
5. **Information Collection** - Reason-specific documentation
6. **Submission** - File dispute and confirm
7. **Feedback** - Collect experience feedback

### Dispute Reason Codes

| Code                 | Description                     |
| -------------------- | ------------------------------- |
| `UIDENTF-CHRG`       | Unrecognized charge             |
| `CHRG-AMNT-MORE`     | Incorrect charge amount         |
| `CHRG-MULTPLE-TIME`  | Duplicate charge                |
| `CANCL-PURCH`        | Cancelled or returned purchase  |
| `CANCL-REC-CHRG`     | Cancelled recurring charge      |
| `CANCl-RECV-GD-SERV` | Goods/services not received     |
| `INDESC-GD-SERV`     | Goods/services not as described |
| `HTMT-RESV`          | Hotel reservation cancellation  |
| `RFD-INCT`           | Incorrect refund                |

## Environment Variables

| Variable            | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `KORE_AI_API_TOKEN` | Bearer token for authenticating with Kore.ai integration APIs |

## Import

```bash
abl import ./examples/DisputeTransaction
```

## Directory Structure

```
DisputeTransaction/
  project.json                                      — v2 project manifest
  agents/
    dispute_transaction_supervisor.agent.abl         — Supervisor/orchestrator
    dispute.agent.abl                               — Dispute processing agent
    agent_transfer.agent.abl                        — Human escalation agent
    feedback_agent.agent.abl                        — Feedback collection agent
  tools/
    dispute.tools.abl                               — Dispute and transaction tools
    transfer.tools.abl                              — Agent transfer tools
    feedback.tools.abl                              — Feedback submission tools
  config/
    project-settings.json                           — Runtime configuration
  environment/
    env-vars.json                                   — Required environment variables
  locales/
    en/                                             — English locale strings per agent
```

## Key Design Patterns

### Channel-Specific Routing

The system detects the interaction channel and routes accordingly. Web/Chat uses UI components for card/transaction selection while IVR/Voice uses voice-optimized one-at-a-time presentation.

### Intelligent Validation

For unrecognized charges (`UIDENTF-CHRG`), the system checks card security, validates authorized users, analyzes transaction patterns using MCC codes, and reclassifies if the issue is actually something else.

### Reason-Driven Workflows

Each dispute reason code triggers specific information collection with different required fields, validation rules, and processing flows.

### Error Handling and Escalation

Graceful degradation at every stage: API failures, validation failures, and customer hesitation all have defined recovery paths.
