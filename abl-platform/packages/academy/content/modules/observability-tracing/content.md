# Observability & Tracing

> **Estimated time**: 38 minutes | **Prerequisites**: Basic agent building, familiarity with Studio navigation

## Learning Objectives

After completing this module, you will be able to:

- Explain the TraceEvent model and how every execution path is captured
- Use the Trace Viewer in Studio to debug agent behavior step-by-step
- Diagnose common issues: empty responses, tool failures, handoff problems, and session hangs
- Configure alert rules for production monitoring
- Set up custom trace dimensions for business-specific observability

## Why Tracing Matters

When an agent produces an unexpected response -- or no response at all -- you need to understand exactly what happened inside the execution pipeline. Agent Platform's tracing system captures every operation the agent performs, creating a complete audit trail from the moment a user message arrives to the final response delivery.

> **Key Concept**: Tracing is a **core platform invariant**. Every execution path emits TraceEvents via a shared TraceStore. There is no ad-hoc logging as a substitute -- the trace system is the authoritative record of what happened during agent execution. This design ensures consistent, structured observability across all agents, tools, and orchestration patterns.

## The TraceEvent Model

Every operation during agent execution produces a TraceEvent -- a structured record with a consistent schema.

### TraceEvent Structure

| Field           | Type        | Description                                                                                           |
| --------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `eventType`     | string      | Category: `llm_call`, `tool_call`, `state_change`, `flow_transition`, `handoff`, `guardrail`, `error` |
| `timestamp`     | ISO 8601    | When the event occurred                                                                               |
| `duration`      | number (ms) | How long the operation took                                                                           |
| `sessionId`     | string      | Which session this belongs to                                                                         |
| `agentName`     | string      | Which agent was executing                                                                             |
| `stepName`      | string      | Which flow step was active (if applicable)                                                            |
| `payload`       | object      | Event-specific data (varies by eventType)                                                             |
| `parentEventId` | string      | Links to parent event for hierarchical tracing                                                        |

### Event Types and Payloads

**LLM Call** (`llm_call`):

```json
{
  "eventType": "llm_call",
  "duration": 1234,
  "payload": {
    "model": "gpt-4o",
    "promptTokens": 850,
    "completionTokens": 120,
    "temperature": 0.7,
    "prompt": "...",
    "completion": "...",
    "cached": false
  }
}
```

**Tool Call** (`tool_call`):

```json
{
  "eventType": "tool_call",
  "duration": 456,
  "payload": {
    "toolName": "search_flights",
    "input": {"origin": "SFO", "destination": "JFK"},
    "output": {"flights": [...]},
    "success": true
  }
}
```

**Flow Transition** (`flow_transition`):

```json
{
  "eventType": "flow_transition",
  "payload": {
    "fromStep": "collect_info",
    "toStep": "search_flights",
    "reason": "all_required_fields_collected"
  }
}
```

**Handoff** (`handoff`):

```json
{
  "eventType": "handoff",
  "payload": {
    "sourceAgent": "Supervisor",
    "targetAgent": "Flight_Search",
    "reason": "intent:search_flights",
    "transferredContext": ["origin", "destination", "date"]
  }
}
```

## Using the Trace Viewer in Studio

The Trace Viewer is your primary debugging tool. Access it through two paths:

### From the Session Browser

1. Navigate to **Operate > Sessions**
2. Click on any session to open the session detail view
3. Switch to the **Trace** tab

### From the Debug Panel

When testing in Studio's integrated chat:

1. Open any agent and switch to the **Chat** tab
2. The split-pane debug panel shows trace events in real time
3. Each event is expandable to show the full payload

### Reading a Trace Timeline

The trace timeline displays events chronologically, with visual indicators:

- **Blue** -- LLM calls (model invocations)
- **Green** -- Successful tool calls
- **Red** -- Errors and failures
- **Orange** -- Guardrail triggers
- **Gray** -- State changes and flow transitions
- **Purple** -- Handoffs and delegations

Each event shows:

- **Event type icon** -- Quick visual identification
- **Duration bar** -- Proportional to execution time
- **Summary line** -- Key information (model name, tool name, target agent)
- **Expandable payload** -- Full details on click

> **Key Concept**: The **duration bar** on each trace event is proportional to execution time. Long bars immediately reveal performance bottlenecks. If an LLM call takes 8 seconds while tool calls take 200ms, you know the model response time is the bottleneck -- not your tool integrations.

## Debugging Common Issues

### Empty Responses

**Symptom**: The agent returns nothing to the user.

**Diagnosis steps using the Trace Viewer**:

1. Check for **LLM call events** -- if none exist, the model is not configured or credentials are missing
2. Look for **error events** -- credential expiration, rate limiting, or model unavailability
3. Check for **guardrail blocks** -- an output guardrail may be blocking the response entirely
4. Verify **flow transitions** -- the agent may be stuck in a step that does not produce output

**Most common causes**:

- Model not configured for the agent
- API credentials expired or missing
- All reasoning disabled (no LLM call triggered)
- Output guardrail blocking the entire response

### Tool Call Failures

**Symptom**: The agent mentions it will look something up but then apologizes or changes the subject.

**Diagnosis**:

1. Find the `tool_call` event in the trace
2. Expand the payload to see the error
3. Common issues: HTTP timeout, authentication failure, malformed request, schema mismatch

```json
{
  "eventType": "tool_call",
  "payload": {
    "toolName": "search_flights",
    "success": false,
    "error": {
      "code": "TIMEOUT",
      "message": "Tool execution timed out after 30000ms"
    }
  }
}
```

### Wrong Agent Responds

**Symptom**: The user asks about billing but gets routed to the technical support agent.

**Diagnosis**:

1. Find the `handoff` event in the supervisor's trace
2. Look at the `reason` field -- what intent was classified?
3. Check the supervisor's LLM call to see the routing decision
4. The issue is usually in the supervisor's routing instructions or the specialist agent descriptions

### Session Hangs

**Symptom**: The conversation stops responding -- no error, no response.

**Diagnosis**:

1. Check for a `tool_call` event with no completion -- the tool may be hanging
2. Look for `flow_transition` loops -- the agent may be cycling between steps
3. Check for GATHER steps waiting for user input that never arrives
4. Look for distributed lock timeouts in concurrent session handling

## Alert Rules for Production Monitoring

Proactive monitoring catches issues before users report them. Configure alert rules under **Operate > Alerts > Alert Rules**.

### Configurable Alert Types

| Alert Type       | Trigger                                             | Example                       |
| ---------------- | --------------------------------------------------- | ----------------------------- |
| **Error Rate**   | Error percentage exceeds threshold in a time window | > 5% errors in 15 minutes     |
| **Latency**      | Response time exceeds threshold                     | P95 latency > 10 seconds      |
| **Volume**       | Session count changes significantly                 | > 50% drop in hourly sessions |
| **Token Budget** | Token consumption approaches limit                  | > 80% of daily token budget   |
| **Eval Score**   | Evaluation scores drop below threshold              | Average score < 0.7           |
| **Deployment**   | New deployment created or rolled back               | Any deployment status change  |

### Notification Targets

Each alert rule sends notifications to one or more targets:

- **Email** -- Direct notification to team members
- **Webhook** -- POST to a URL (integrates with Slack, PagerDuty, OpsGenie)
- **In-app** -- Notification in Studio's alert inbox

### Alert Rule Example

A production monitoring setup might include:

1. **Critical**: Error rate > 10% in 5 minutes → PagerDuty webhook
2. **Warning**: P95 latency > 8 seconds → Slack webhook
3. **Info**: Daily token usage > 80% of budget → Email to team lead
4. **Info**: New deployment created → Slack channel notification

## Custom Trace Dimensions

Standard trace events capture platform-level data. Custom trace dimensions let you add business-specific metadata to trace events.

### Setting Up Custom Dimensions

1. Navigate to **Project Settings > Trace Dimensions**
2. Add a new dimension with a name, type, and description
3. Emit the dimension from your agent's flow steps

```abl
resolve_ticket:
  REASONING: false
  SET:
    - ticket_status = "resolved"
  TRACE:
    resolution_type: "automated"
    ticket_category: "{{ticket.category}}"
    customer_tier: "{{customer.tier}}"
  RESPOND: "Your ticket has been resolved."
  THEN: satisfaction_survey
```

### Querying Custom Dimensions

Custom dimensions appear in the Insights dashboard as filterable fields. You can:

- **Filter sessions** by dimension values (e.g., show only sessions where `resolution_type = "escalated"`)
- **Group metrics** by dimensions (e.g., containment rate by `customer_tier`)
- **Create alerts** based on dimension values (e.g., alert when `resolution_type = "escalated"` exceeds a threshold)

## Log Correlation

For teams running Agent Platform alongside other services, trace events include correlation IDs that link to external systems.

### Correlation Fields

| Field               | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `sessionId`         | Correlate with platform session data in MongoDB                |
| `traceId`           | Link to distributed tracing systems (OpenTelemetry compatible) |
| `externalMessageId` | Correlate with channel platform logs (Slack, Teams, WhatsApp)  |
| `requestId`         | Link to HTTP request logs in load balancers and API gateways   |

These correlation fields enable end-to-end debugging across the full request lifecycle -- from the user's channel client, through the platform, to external tool APIs, and back.

## Key Takeaways

- Every execution path emits TraceEvents via the shared TraceStore -- this is a core platform invariant, not optional logging
- The Trace Viewer's duration bars immediately reveal performance bottlenecks in LLM calls, tool executions, and flow transitions
- Empty responses are most commonly caused by missing model configuration or expired credentials -- check the trace for LLM call events first
- Alert rules under Operate > Alerts provide proactive monitoring for error rates, latency, volume, token budgets, and eval scores
- Custom trace dimensions bridge platform observability and business metrics, enabling filtered analytics and business-specific alerts

## What's Next

Explore the **Analytics & Insights** module for dashboard-level analytics and cost optimization, or the **Testing & Evaluation** module to learn how evaluation frameworks systematically measure agent quality before deployment.
