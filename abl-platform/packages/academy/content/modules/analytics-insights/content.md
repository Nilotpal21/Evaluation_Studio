# Analytics & Insights

> **Estimated time**: 40 minutes | **Prerequisites**: Familiarity with Studio navigation and agent deployment basics

## Learning Objectives

After completing this module, you will be able to:

- Understand the analytics data pipeline from trace events to dashboard visualizations
- Use the Insights dashboard to monitor KPIs, costs, and agent performance
- Leverage intent analysis and sentiment tracking for conversation quality insights
- Configure custom trace dimensions for business-specific metrics
- Export analytics data for integration with external BI tools

## Analytics Architecture

Agent Platform's analytics system processes raw execution data into actionable insights through a multi-stage pipeline. Understanding this architecture helps you know where your data comes from and what you can do with it.

### The Data Pipeline

```
Runtime Execution → TraceEvents → Event Ingestion → ClickHouse → Materialized Views → Dashboard Queries
                                        ↓
                                   MongoDB (raw)
```

Every agent execution emits **TraceEvents** -- structured records of LLM calls, tool invocations, state changes, and decision points. These events flow into two destinations:

1. **MongoDB** -- Stores the raw trace data for session replay and debugging. This is always available.
2. **ClickHouse** (optional) -- Ingests trace events and computes pre-aggregated materialized views for fast analytical queries. This powers the Insights dashboards.

> **Key Concept**: ClickHouse is the analytics engine that powers the Insights dashboards. It stores pre-aggregated materialized views computed from ingested trace events -- things like hourly session counts, average response latency, token consumption by agent, and cost estimates. This separation means analytics queries never impact your primary MongoDB database or Runtime performance.

### What Gets Tracked

The analytics pipeline captures data at multiple levels:

| Level         | Data Points                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| **Session**   | Start/end time, duration, turn count, completion status, channel, containment |
| **Turn**      | User message, agent response, latency, token count (input + output)           |
| **LLM Call**  | Model used, prompt tokens, completion tokens, latency, cache hits             |
| **Tool Call** | Tool name, execution time, success/failure, input/output size                 |
| **Handoff**   | Source agent, target agent, reason, timing                                    |
| **Guardrail** | Trigger type, action taken, content matched                                   |

## The Insights Dashboard

Navigate to **Insights > Dashboard** in Studio to access the main analytics view. The dashboard is organized into KPI cards, trend charts, and breakdown tables.

### Five KPI Metric Cards

The dashboard header displays five primary KPI metric cards:

| Metric               | Description                                              | Why It Matters                |
| -------------------- | -------------------------------------------------------- | ----------------------------- |
| **Sessions**         | Total conversation count in the selected period          | Measures overall usage volume |
| **Messages**         | Total messages exchanged (user + agent)                  | Indicates conversation depth  |
| **Tokens**           | Total LLM tokens consumed (input + output)               | Primary cost driver           |
| **Estimated Cost**   | Computed from token usage and model pricing              | Budget monitoring             |
| **Containment Rate** | Percentage of sessions resolved without human escalation | Agent effectiveness           |

Each metric card includes a **trend indicator** showing percentage change compared to the previous period. Select from 7-day, 30-day, or 90-day date ranges using the period selector.

> **Key Concept**: **Containment Rate** is the most important operational KPI. It measures the percentage of sessions where the agent resolved the user's request without escalating to a human. A high containment rate means your agents handle requests effectively. A declining rate signals something needs attention -- perhaps new intents are not being handled, tools are failing, or the agent's instructions need updating.

### Trend Charts

Below the KPI cards, interactive trend charts visualize metrics over time. Toggle between:

- **Sessions over time** -- Daily or hourly session volume
- **Token usage** -- Input vs. output token consumption
- **Cost over time** -- Daily estimated spend
- **Response latency** -- Average and P95 response times

### Cost Breakdown by Agent

The cost breakdown table groups spending by agent. Each row shows:

- **Agent name** -- Which agent handled the sessions
- **Sessions handled** -- Number of conversations
- **Tokens consumed** -- Total token usage
- **Estimated cost** -- Calculated from token usage and model pricing

Use this table to identify which agents drive the most resource consumption. An agent with high token usage might benefit from conversation sliding windows, model tier optimization, or instruction refinement.

## Agent Performance Analytics

Navigate to **Insights > Agent Performance** for per-agent metrics:

### Per-Agent Metrics

| Metric                     | Description                                                |
| -------------------------- | ---------------------------------------------------------- |
| **Avg. Response Time**     | Mean time from user message to agent response              |
| **P95 Latency**            | 95th percentile response time (worst-case user experience) |
| **Avg. Turns per Session** | How many exchanges before resolution                       |
| **Tool Success Rate**      | Percentage of tool calls that succeed                      |
| **Handoff Rate**           | How often the agent escalates to another agent or human    |
| **Containment Rate**       | Per-agent resolution rate                                  |

### Quality Monitor

Navigate to **Insights > Quality Monitor** for evaluation-driven quality tracking:

- **Eval Score Trends** -- Track how evaluation scores change over time
- **Pass Rate by Evaluator** -- Which quality criteria agents pass or fail most
- **Score Distribution** -- Histogram of scores across eval runs

## Intent Analysis

The intent analysis pipeline classifies user messages to determine what users are trying to accomplish. This data powers both runtime routing decisions and analytical insights.

### How Intent Classification Works

When a user sends a message, the supervisor agent (or a dedicated classifier) identifies the user's intent -- for example, `check_balance`, `book_flight`, `file_complaint`, or `general_inquiry`. These classifications are recorded as trace events and aggregated in analytics.

### Intent Analytics in the Dashboard

The intent analysis view shows:

- **Top Intents** -- Most frequently detected intents, ranked by volume
- **Intent Resolution Rate** -- Which intents are resolved autonomously vs. escalated
- **Intent Trends** -- How intent volumes change over time (seasonal patterns, new topics emerging)
- **Unmatched Intents** -- Messages that did not match any known intent (candidates for new agent capabilities)

> **Key Concept**: Monitoring **unmatched intents** reveals gaps in your agent system. When users ask questions that do not map to any known intent, those messages represent unhandled use cases. Regularly reviewing unmatched intents helps you prioritize which new capabilities to add to your agents.

## Sentiment Tracking

Sentiment analysis evaluates the emotional tone of user messages throughout a conversation, providing insights into customer satisfaction and conversation quality.

### Sentiment Signals

| Signal         | Description                                      |
| -------------- | ------------------------------------------------ |
| **Positive**   | User is satisfied, grateful, or engaged          |
| **Neutral**    | Informational exchange, no strong emotion        |
| **Negative**   | User is frustrated, confused, or dissatisfied    |
| **Escalating** | Sentiment is deteriorating over the conversation |

### Using Sentiment Data

- **Per-session sentiment arc** -- Track how sentiment changes through a conversation. A session that starts neutral and ends negative suggests the agent failed to resolve the issue.
- **Aggregate sentiment by agent** -- Compare sentiment scores across agents to identify which agents create the best user experiences.
- **Sentiment-triggered alerts** -- Configure alert rules to notify when negative sentiment rates exceed a threshold.

## Custom Trace Dimensions

Standard analytics cover sessions, tokens, latency, and costs. But what about business-specific metrics like "booking conversion rate" or "support ticket created"? Custom trace dimensions let you track exactly what matters to your business.

### Configuring Custom Dimensions

Navigate to **Project Settings > Trace Dimensions** to define custom metadata fields:

1. **Define the dimension** -- Give it a name (e.g., `booking_started`, `booking_completed`, `ticket_created`) and a data type (string, number, boolean).
2. **Emit from agent flows** -- In your agent's flow steps, emit the dimension value when the relevant event occurs.
3. **Query in dashboards** -- Custom dimensions appear as filterable fields in the Insights dashboard.

```abl
complete_booking:
  REASONING: false
  SET:
    - booking_confirmed = true
  TRACE:
    booking_completed: true
    booking_value: "{{total_price}}"
  RESPOND: "Your booking is confirmed!"
  THEN: COMPLETE
```

> **Key Concept**: Custom trace dimensions bridge the gap between platform metrics and business metrics. While the platform automatically tracks sessions, tokens, and latency, your business cares about conversions, resolutions, and revenue impact. Custom dimensions let you measure these without external analytics tools.

### Practical Examples

| Dimension             | Type    | Use Case                           |
| --------------------- | ------- | ---------------------------------- |
| `booking_completed`   | boolean | Track booking funnel conversion    |
| `support_tier`        | string  | Segment analytics by support level |
| `resolution_category` | string  | Classify how issues were resolved  |
| `customer_segment`    | string  | Track performance by customer type |
| `escalation_reason`   | string  | Understand why agents escalate     |

## Data Export & BI Integration

For advanced analytics beyond the built-in dashboards, Agent Platform supports data export and external tool integration.

### Export Options

- **CSV Export** -- Download dashboard data as CSV files for spreadsheet analysis
- **API Access** -- Query analytics data programmatically via the Management API
- **ClickHouse Direct** -- For self-hosted deployments, query ClickHouse directly using SQL

### Integration Patterns

For teams using external BI tools (Tableau, Looker, Power BI, Metabase):

1. **API polling** -- Periodically fetch analytics data via the Management API and load into your data warehouse
2. **Event streaming** -- For deployments with Kafka enabled, subscribe to analytics events for real-time ingestion
3. **Direct ClickHouse** -- Connect your BI tool directly to ClickHouse for SQL-based analytics (self-hosted only)

## Cost Optimization Tips

The analytics dashboard provides the data you need to optimize costs:

1. **Identify high-cost agents** -- Use the cost breakdown table to find agents with disproportionate token usage
2. **Enable conversation sliding windows** -- Limit conversation history sent to the LLM, reducing input token costs for long sessions
3. **Right-size model tiers** -- Use Fast models for simple classification tasks, Standard for general conversation, Premium only where quality demands it
4. **Set daily token budgets** -- Prevent runaway sessions from consuming the monthly budget in a single day
5. **Review unused agents** -- Archive inactive agents and projects to reduce cognitive overhead and accidental usage

## Key Takeaways

- ClickHouse powers the Insights dashboards with pre-aggregated materialized views, keeping analytics queries separate from the primary MongoDB database
- Containment Rate is the most important operational KPI -- it measures how effectively agents resolve requests without human escalation
- Intent analysis reveals what users are trying to accomplish; monitoring unmatched intents identifies gaps in agent capabilities
- Custom trace dimensions bridge platform metrics and business metrics, enabling conversion tracking, segmentation, and business-specific analytics
- The cost breakdown table identifies which agents drive resource consumption, guiding optimization efforts

## What's Next

Explore the **Observability & Tracing** module for deep-dive debugging with trace events, or the **Quality Assurance** module to learn how evaluation frameworks systematically measure agent quality.
