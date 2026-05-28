# EventStore Dashboard Research: Industry Analysis & Design Specification

> **Date:** 2026-03-01
> **Scope:** Comprehensive research on analytics dashboards from 15+ AI/agent platforms, mapped to our 45+ event types and existing API infrastructure
> **Purpose:** Define what dashboard pages, charts, and visualizations we should build in Studio

---

## Executive Summary

We have 45+ event types flowing into ClickHouse, 8 analytics API endpoints built, and Recharts already installed in Studio. What's missing is the **UI layer** — the dashboard pages that consume these APIs and present actionable insights.

This document analyzes dashboards from LangSmith, Langfuse, Helicone, Arize Phoenix, AgentOps, Lunary, Portkey, Braintrust, HoneyHive, Voiceflow, and others, then specifies exactly which dashboards to build, what charts go on each, and which of our event types power them.

---

## Part 1: Industry Dashboard Landscape

### 1.1 Common Dashboard Pages Across Platforms

Every platform reviewed has some variation of these core pages:

| Dashboard Page           | Present In                                                 | Description                                          |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------- |
| **Overview / Home**      | All 15 platforms                                           | KPI summary cards + trend charts                     |
| **Traces / Requests**    | LangSmith, Langfuse, Helicone, Phoenix, HoneyHive, Portkey | Request log with filtering + trace detail            |
| **Sessions**             | Langfuse, Helicone, AgentOps, Lunary, Voiceflow            | Session list with replay/drill-down                  |
| **LLM Analytics**        | Helicone, Portkey, Langfuse, Lunary                        | Model-specific cost, latency, token charts           |
| **Cost & Usage**         | Helicone, Portkey, Langfuse, Lunary, LangSmith             | Spend tracking, budget alerts, model cost comparison |
| **Evaluations**          | LangSmith, Langfuse, Braintrust, Phoenix, HoneyHive        | Quality scores, judge results, regression detection  |
| **Agents**               | AgentOps, CrewAI, HoneyHive                                | Agent topology, handoff flow, per-agent metrics      |
| **Users / Channels**     | Helicone, Lunary, Voiceflow                                | Per-user/channel usage and engagement                |
| **Alerts & Monitors**    | Helicone, Portkey, Langfuse                                | Threshold-based notifications                        |
| **Playground / Prompts** | LangSmith, Langfuse, Helicone, Braintrust                  | Prompt testing and versioning                        |

### 1.2 Platform-by-Platform Dashboard Details

#### LangSmith (LangChain)

- **Monitoring Dashboard**: Time-series charts for trace count, latency P50/P95/P99, error rate, token throughput, cost over time. Grouped by run type (Chain, LLM, Tool, Retriever).
- **Traces Page**: Searchable table with columns: Name, Run Type, Latency, Tokens, Status, Feedback Score, Timestamp. Expandable trace tree showing parent-child spans. Click into any span for full I/O.
- **Feedback Tab**: Aggregated thumbs up/down scores, star ratings, human annotation results per trace.
- **Datasets & Experiments**: Side-by-side experiment comparison table with per-example scores, model outputs, and diffs.
- **Unique**: "Rules" engine — auto-tag traces based on conditions, trigger evaluators on matching traces.

#### Langfuse

- **Dashboard (Home)**: 6 KPI cards (Total Traces, Total Observations, Unique Users, Avg Latency, Total Cost, Error Rate). Time-series area charts below for traces over time, cost over time, latency distribution. Model usage pie chart.
- **Traces Page**: Table with: Trace ID, Name, User ID, Total Tokens, Latency, Cost, Timestamp, Tags. Click expands to waterfall view of observations (LLM → Tool → Retriever nested).
- **Sessions Page**: Grouped by session ID. Shows turn count, duration, total cost. Click opens full conversation replay.
- **Scores Page**: Grid of evaluation results with distributions (histogram of scores by evaluator). Trend lines for quality over time.
- **Metrics Page**: Custom chart builder — select metric (cost, latency, count), dimension (model, user, trace_name), and time granularity. Outputs line/bar charts.
- **Unique**: PostHog integration — pushes aggregated metrics (generation count, cost, latency, token usage per trace) to product analytics for cross-correlation with business KPIs.

#### Helicone

- **Main Dashboard**: 8 KPI cards (Requests, Avg Latency, Avg TTFT, Avg Tokens, Total Cost, Error %, Cache Hit Rate, Active Users). Line charts for requests over time, latency trends, cost trends. Segmented by model/provider.
- **Requests Page**: Full request log table with: Timestamp, Status, Model, Prompt/Completion tokens, Latency, TTFT, Cost, User, Custom Properties. Advanced filters (20+ filter dimensions). Click opens full request/response with token highlighting.
- **Sessions Page**: Session timeline view showing request chain. Session path visualization (tree structure of parent-child calls).
- **Users Page**: Per-user analytics: request count, total cost, avg latency, last active, custom properties. User segmentation (power users, casual, at-risk, new).
- **Alerts Page**: Configurable alerts on: error rate > X%, latency > Xms, cost > $X, request volume anomaly.
- **Unique**: TTFT tracking, cache hit rate dashboard, rate limiting analytics, automatic user segmentation.

#### Arize Phoenix

- **Traces Page**: Span tree with waterfall visualization. Each span shows: type badge (LLM/TOOL/RETRIEVER/RERANKER/EMBEDDING), duration bar, token count, status.
- **Evaluations Tab**: Evaluation scores as overlay on traces. Score distributions as histograms. Regression detection between time periods.
- **Embeddings View**: 2D/3D UMAP/t-SNE visualization of embedding vectors. Cluster identification for drift detection.
- **Unique**: OpenInference-native (OTel-based), embedding drift visualization, retrievals page with relevance scoring.

#### AgentOps

- **Session Dashboard**: Session list with state badges (Success/Failure/Indeterminate). Session cost, duration, LLM calls, tool calls per session. Session timeline (Gantt-like).
- **Agent View**: Multi-agent interaction graph showing handoffs between agents. Per-agent metrics: call count, success rate, avg duration.
- **Time Travel Debugging**: Step-by-step replay of agent execution with state snapshots at each step.
- **Analytics Page**: Aggregate charts: sessions over time, success rate trend, cost trend, avg duration trend.
- **Unique**: Session state classification (Success/Failure/Indeterminate), multi-agent interaction graph, host environment tracking, time-travel debugging.

#### Lunary

- **Dashboard**: KPI row (Total Messages, Users, Avg Cost, Avg Latency, Satisfaction Score). Trend charts for daily messages, cost, and user count.
- **Logs Page**: Message-level log with: Role (user/assistant), Content preview, Tokens, Cost, Latency, User, Tags. Full conversation thread view.
- **Users Page**: User list with: message count, session count, avg satisfaction, last active. Click into user for conversation history.
- **Analytics Page**: Charts for: topic distribution (auto-classified), language distribution, sentiment over time, token usage by model.
- **Unique**: Automatic topic classification, language detection, PII detection/masking, user satisfaction tracking, template detection.

#### Portkey

- **Analytics Dashboard**: 21+ metrics organized in cards: Total Requests, Tokens (In/Out/Total), Cost, Latency (mean, P50, P95, P99), TTFT, Error Rate, Cache Hit Rate. All with sparkline trends.
- **Logs Page**: Request log with: Gateway ID, Model, Provider, Status, Tokens, Cost, Latency, Metadata. Advanced filtering with saved views.
- **Budget Tracking**: Real-time spend vs. budget visualization. Per-API-key budget limits with alerts.
- **Unique**: 21 built-in metrics, budget caps with automatic blocking, virtual keys with cost limits, prompt management with A/B testing.

#### Voiceflow

- **Conversations Dashboard**: Session list with: user, channel, duration, turns, resolution status. Full conversation replay with agent response + user messages interleaved.
- **Analytics Page**: Engagement metrics: sessions/day, avg session length, avg turns per session, unique users. Funnel charts for conversation flow. Drop-off analysis showing where users abandon.
- **Flow Analytics**: Per-step metrics on the flow canvas: visits, completion rate, avg time spent. Heatmap overlay on flow steps showing traffic distribution.
- **Unique**: Flow-step heatmap, conversation funnel/drop-off analysis, NLU confidence scores, containment rate tracking.

#### HoneyHive

- **Traces Dashboard**: Distributed tracing with spans. 25+ built-in evaluators running as sidecars on traces. Each trace shows evaluation scores inline.
- **Datasets Page**: Golden dataset management with trace-to-dataset flow.
- **Monitors Page**: Time-series charts for any evaluator score. Regression alerts when scores drop.
- **Unique**: 25+ built-in evaluators (faithfulness, relevance, toxicity, PII, coherence, etc.), MCP/A2A protocol support, regression detection.

#### Braintrust

- **Experiments Page**: Side-by-side comparison of prompt variants. Per-example diff view showing how outputs changed. Aggregate score comparison (bar chart).
- **Logs Page**: Production trace log with inline scoring.
- **Unique**: Git-like experiment versioning, per-example regression detection, scoring functions library.

---

## Part 2: Dashboard Design Specification for Studio

Based on industry analysis and our event types, here are the 8 dashboard pages to build, ordered by priority.

---

### Dashboard 1: Analytics Overview (Home)

**Route:** `/projects/:projectId/analytics`
**Priority:** P0 — First dashboard to build
**Industry precedent:** Every platform has this

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Date Range Picker: 24h | 7d | 30d | Custom]    [Auto-refresh] │
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┤
│ Sessions │ Messages │ LLM Calls│ Errors   │  Tokens  │   Cost   │
│  1,247   │  8,493   │  4,126   │  23 (2%) │  2.1M    │  $47.32  │
│  ↑12%    │  ↑8%     │  ↑5%     │  ↓15%    │  ↑10%    │  ↑7%     │
├──────────┴──────────┴──────────┴──────────┴──────────┴──────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Event Volume Over Time (Area Chart, stacked by category)  │  │
│ │  X: time (hour/day), Y: event count                        │  │
│ │  Series: session, message, llm, tool, agent, flow          │  │
│ └─────────────────────────────────────────────────────────────┘  │
├─────────────────────────────┬────────────────────────────────────┤
│ ┌─────────────────────────┐ │ ┌──────────────────────────────┐   │
│ │ Events by Category      │ │ │ Top Agents by Volume         │   │
│ │ (Donut/Pie Chart)       │ │ │ (Horizontal Bar Chart)       │   │
│ │ session: 24%            │ │ │ booking_agent:  ████████ 412 │   │
│ │ llm: 31%                │ │ │ support_agent:  ██████  301  │   │
│ │ tool: 18%               │ │ │ faq_agent:      ████   189   │   │
│ │ agent: 15%              │ │ │ triage_agent:   ███    142   │   │
│ │ other: 12%              │ │ │                              │   │
│ └─────────────────────────┘ │ └──────────────────────────────┘   │
├─────────────────────────────┴────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Latency Trend (Line Chart)                                 │  │
│ │  Lines: avg, p95 latency_ms from llm.call.completed         │  │
│ │  X: time, Y: milliseconds                                   │  │
│ └─────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Recent Errors (Table, max 10 rows)                         │  │
│ │  Time | Event Type | Agent | Error Message                  │  │
│ └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

#### KPI Cards (6)

| Card             | Value Source                                    | Comparison            |
| ---------------- | ----------------------------------------------- | --------------------- |
| **Sessions**     | `count` where `event_type = session.started`    | vs. previous period % |
| **Messages**     | `count` where `category = message`              | vs. previous period % |
| **LLM Calls**    | `count` where `event_type = llm.call.completed` | vs. previous period % |
| **Error Rate**   | `error_rate` across all events                  | vs. previous period % |
| **Total Tokens** | `sum_tokens` from `llm.call.completed`          | vs. previous period % |
| **Total Cost**   | `sum_cost` from `llm.call.completed`            | vs. previous period % |

#### Charts

| Chart                  | Type           | API Call                                                                                                | Event Types               |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------- | ------------------------- |
| Event Volume Over Time | Stacked Area   | `POST /aggregate` groupBy=`['hour']` or `['day']`, metrics=`['count']`                                  | All                       |
| Events by Category     | Donut/Pie      | `GET /event-counts`                                                                                     | All                       |
| Top Agents by Volume   | Horizontal Bar | `POST /aggregate` groupBy=`['agent_name']`, metrics=`['count']`                                         | `agent.entered`           |
| Latency Trend          | Multi-line     | `POST /aggregate` groupBy=`['hour']`, metrics=`['avg_duration', 'p95_duration']`, filter `category=llm` | `llm.call.completed`      |
| Recent Errors          | Table          | `GET /events` filter `hasError=true`, limit=10                                                          | All with `has_error=true` |

---

### Dashboard 2: Sessions

**Route:** `/projects/:projectId/analytics/sessions`
**Priority:** P0
**Industry precedent:** Langfuse, AgentOps, Helicone, Lunary, Voiceflow

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Date Range]  [Channel ▼]  [Agent ▼]  [Status ▼]  [Search]     │
├──────────┬──────────┬──────────┬──────────────────────────────────┤
│ Sessions │ Completed│ Avg Dur  │ Avg Cost                         │
│  1,247   │  89%     │  4m 23s  │ $0.038                           │
├──────────┴──────────┴──────────┴──────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Sessions Over Time (Bar Chart, colored by outcome)         │  │
│ │  completed: ████  timeout: ██  error: █  user_exit: █       │  │
│ └─────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ Session List (Sortable Table)                                    │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Session ID | Agent    | Channel | Turns | Duration | Cost   │ │
│ │            |          |         |       |          | Status │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │ abc-123... | booking  | web     | 8     | 3m 12s   | $0.04  │ │
│ │            |          |         |       |          | ✓      │ │
│ │ def-456... | support  | sdk     | 12    | 7m 45s   | $0.09  │ │
│ │            |          |         |       |          | ⚠ err  │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

#### Drill-down: Session Detail (click a session row)

```
┌──────────────────────────────────────────────────────────────────┐
│ Session abc-123...  │ Agent: booking_agent  │ Duration: 3m 12s   │
│ Channel: web_debug  │ Status: Completed     │ Cost: $0.042       │
├──────────────────────────────────────────────────────────────────┤
│ [Conversation] [Trace Timeline] [State Changes] [Events]         │
├──────────────────────────────────────────────────────────────────┤
│ CONVERSATION TAB:                                                │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 👤 User: I'd like to book a room for next Friday            │ │
│ │ 🤖 Agent: I'd be happy to help! Let me check availability...│ │
│ │ 👤 User: For 2 adults, 1 child                              │ │
│ │ 🤖 Agent: Great, here are the available rooms: ...          │ │
│ └──────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────┤
│ TRACE TIMELINE TAB:                                              │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ ├─ session.started            0ms                           │ │
│ │ ├─ message.user.received      +2ms    (45 chars)            │ │
│ │ ├─ agent.entered              +5ms    booking_agent         │ │
│ │ │  ├─ llm.call.completed      +120ms  claude-3.5 (234 tok) │ │
│ │ │  ├─ tool.call.completed     +340ms  check_availability    │ │
│ │ │  └─ llm.call.completed      +580ms  claude-3.5 (412 tok) │ │
│ │ ├─ agent.exited               +620ms                        │ │
│ │ ├─ message.agent.sent         +625ms  (312 chars)           │ │
│ │ └─ session.updated            +630ms  [room_type, dates]    │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

#### Data Sources

| Element            | API                                                             | Event Types                        |
| ------------------ | --------------------------------------------------------------- | ---------------------------------- |
| KPI Cards          | `GET /session-metrics`                                          | `session.started`, `session.ended` |
| Sessions Over Time | `POST /aggregate` groupBy=`['day']`, filter category=session    | `session.started`                  |
| Session List       | `GET /events` filter `eventTypes=session.started,session.ended` | Session events                     |
| Session Detail     | `GET /events` filter `sessionId=X` (all events for session)     | All                                |

---

### Dashboard 3: LLM Performance

**Route:** `/projects/:projectId/analytics/llm`
**Priority:** P0
**Industry precedent:** Helicone, Portkey, Langfuse (all platforms' most used dashboard)

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Date Range]  [Model ▼]  [Provider ▼]  [Agent ▼]               │
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┤
│ LLM Calls│ Avg Lat  │ P95 Lat  │  TTFT    │ Tokens   │  Cost    │
│  4,126   │  340ms   │  890ms   │  120ms   │  2.1M    │ $47.32   │
├──────────┴──────────┴──────────┴──────────┴──────────┴──────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Latency Distribution (Line Chart: avg + P95 over time)     │  │
│ │  Secondary Y-axis: TTFT overlay                             │  │
│ └─────────────────────────────────────────────────────────────┘  │
├─────────────────────────────┬────────────────────────────────────┤
│ ┌─────────────────────────┐ │ ┌──────────────────────────────┐   │
│ │ Token Usage Over Time   │ │ │ Cost by Model (Pie Chart)    │   │
│ │ (Stacked Area Chart)    │ │ │ claude-3.5-sonnet: $28       │   │
│ │ input_tokens (blue)     │ │ │ gpt-4o: $12                  │   │
│ │ output_tokens (green)   │ │ │ gpt-4o-mini: $4              │   │
│ │ cache_read (purple)     │ │ │ other: $3                    │   │
│ └─────────────────────────┘ │ └──────────────────────────────┘   │
├─────────────────────────────┴────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Model Comparison Table (Sortable)                          │  │
│ │  Model       | Calls | Avg Lat | P95  | Tokens | Cost | Err│  │
│ │  claude-3.5  | 2,341 | 320ms   | 780  | 1.2M   | $28  | 1%│  │
│ │  gpt-4o      |   892 | 410ms   | 1.1s | 580K   | $12  | 3%│  │
│ │  gpt-4o-mini | 1,204 | 180ms   | 420  | 320K   | $4   | 1%│  │
│ └─────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Error Breakdown (Bar Chart by error_type)                  │  │
│ │  rate_limit: ████████  12                                   │  │
│ │  timeout:    ████      6                                    │  │
│ │  auth:       ██        3                                    │  │
│ │  other:      █         2                                    │  │
│ └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

#### Data Sources

| Element         | API                                                         | Event Types          | Metrics                                                 |
| --------------- | ----------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| KPI Cards       | `POST /aggregate` filter `category=llm`                     | `llm.call.completed` | count, avg_duration, p95_duration, sum_tokens, sum_cost |
| Latency Trend   | `POST /aggregate` groupBy=`['hour']`                        | `llm.call.completed` | avg_duration, p95_duration                              |
| Token Usage     | `POST /aggregate` groupBy=`['hour']`                        | `llm.call.completed` | sum_tokens (+ dataField for input/output split)         |
| Cost by Model   | `GET /cost-breakdown`                                       | `llm.call.completed` | sum_cost grouped by model                               |
| Model Table     | `GET /cost-breakdown`                                       | `llm.call.completed` | All metrics per model                                   |
| Error Breakdown | `POST /aggregate` groupBy=`['event_type']`, filter hasError | `llm.call.failed`    | count                                                   |

---

### Dashboard 4: Agent Performance

**Route:** `/projects/:projectId/analytics/agents`
**Priority:** P1
**Industry precedent:** AgentOps, HoneyHive, CrewAI (unique to agent platforms)

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Date Range]  [Agent ▼]                                         │
├──────────┬──────────┬──────────┬──────────────────────────────────┤
│ Agents   │ Handoffs │ Escalated│ Avg Duration                     │
│    7     │   142    │    8     │  2.4s                            │
├──────────┴──────────┴──────────┴──────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Agent Topology Graph (Interactive, like AgentOps)          │  │
│ │  Nodes = agents, Edges = handoffs/delegates                 │  │
│ │  Node size = volume, Edge thickness = frequency             │  │
│ │  Color: green = healthy, yellow = warn, red = errors        │  │
│ └─────────────────────────────────────────────────────────────┘  │
├─────────────────────────────┬────────────────────────────────────┤
│ ┌─────────────────────────┐ │ ┌──────────────────────────────┐   │
│ │ Agent Volume Over Time  │ │ │ Handoff Sankey Diagram       │   │
│ │ (Stacked Area Chart)    │ │ │ triage → booking: 89         │   │
│ │ Each series = agent     │ │ │ triage → support: 42         │   │
│ │                         │ │ │ support → escalation: 8      │   │
│ └─────────────────────────┘ │ └──────────────────────────────┘   │
├─────────────────────────────┴────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Agent Performance Table (Sortable)                         │  │
│ │  Agent        | Sessions | Avg Dur | Err% | Handoffs | Cost │  │
│ │  booking      | 412      | 2.1s    | 1.2% | 89 in    | $18  │  │
│ │  support      | 301      | 3.4s    | 2.8% | 42 in    | $12  │  │
│ │  triage       | 523      | 0.8s    | 0.5% | 131 out  | $8   │  │
│ └─────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ AGENT DETAIL (click row → expands):                              │
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  booking_agent                                              │  │
│ │  ┌────────────┐ ┌─────────────┐ ┌──────────────────┐       │  │
│ │  │ Constraint │ │ Tool Calls  │ │ Decision Types   │       │  │
│ │  │ Violations │ │ Bar Chart   │ │ Pie Chart        │       │  │
│ │  │ Timeline   │ │ per tool    │ │ routing/handoff  │       │  │
│ │  └────────────┘ └─────────────┘ └──────────────────┘       │  │
│ └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

#### Data Sources

| Element               | Event Types                                                         |
| --------------------- | ------------------------------------------------------------------- |
| Agent Topology Graph  | `agent.handoff`, `agent.delegated`, `agent.entered`                 |
| Handoff Sankey        | `agent.handoff` (from_agent → to_agent)                             |
| Agent Volume          | `agent.entered` grouped by agent_name over time                     |
| Agent Table           | `agent.entered`, `agent.exited`, `agent.handoff`, `agent.escalated` |
| Constraint Violations | `agent.constraint.checked` where `passed=false`                     |
| Tool Calls per Agent  | `tool.call.completed`, `tool.call.failed` filtered by agent_name    |
| Decision Types        | `agent.decision` grouped by decision_type                           |

---

### Dashboard 5: Cost & Usage

**Route:** `/projects/:projectId/analytics/cost`
**Priority:** P1
**Industry precedent:** Helicone, Portkey, Langfuse, Lunary

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Date Range]  [Model ▼]  [Agent ▼]  [Channel ▼]                │
├──────────┬──────────┬──────────┬─────────────────────────────────┤
│ Total $  │ Daily Avg│ Per Sess │ Projected Monthly               │
│ $47.32   │  $6.76   │  $0.038  │ $203                            │
├──────────┴──────────┴──────────┴─────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Daily Cost Trend (Area Chart)                              │  │
│ │  Stacked by model or by agent (toggle)                      │  │
│ └─────────────────────────────────────────────────────────────┘  │
├─────────────────────────────┬────────────────────────────────────┤
│ ┌─────────────────────────┐ │ ┌──────────────────────────────┐   │
│ │ Cost by Model (Pie)     │ │ │ Cost by Agent (Pie)          │   │
│ │ claude-3.5: 60%         │ │ │ booking: 38%                 │   │
│ │ gpt-4o: 25%             │ │ │ support: 25%                 │   │
│ │ gpt-4o-mini: 10%        │ │ │ triage: 17%                  │   │
│ │ other: 5%               │ │ │ other: 20%                   │   │
│ └─────────────────────────┘ │ └──────────────────────────────┘   │
├─────────────────────────────┴────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Token Efficiency Table                                     │  │
│ │  Model       | Input Tok | Output Tok | Cache Hits | $/1K   │  │
│ │  claude-3.5  | 842K      | 358K       | 124K       | $0.023 │  │
│ │  gpt-4o      | 321K      | 259K       | 0          | $0.021 │  │
│ └─────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Top Cost Sessions (Table, top 20 most expensive)           │  │
│ │  Session ID | Agent | Turns | Tokens | Cost | Duration      │  │
│ └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

#### Data Sources

| Element           | Event Types          | New API Needed?                                                             |
| ----------------- | -------------------- | --------------------------------------------------------------------------- |
| KPI Cards         | `llm.call.completed` | No — `GET /cost-breakdown` + `GET /session-metrics`                         |
| Daily Cost Trend  | `llm.call.completed` | No — `POST /aggregate` groupBy=`['day']`, metrics=`['sum_cost']`            |
| Cost by Model     | `llm.call.completed` | No — `GET /cost-breakdown`                                                  |
| Cost by Agent     | `llm.call.completed` | No — `POST /aggregate` groupBy=`['agent_name']`, metrics=`['sum_cost']`     |
| Token Efficiency  | `llm.call.completed` | Partially — need `cache_read_tokens` aggregation (new dataField query)      |
| Top Cost Sessions | All (per session)    | **Yes** — Need a new API endpoint: `GET /top-sessions?sortBy=cost&limit=20` |

---

### Dashboard 6: Tools

**Route:** `/projects/:projectId/analytics/tools`
**Priority:** P2
**Industry precedent:** LangSmith (Retriever/Tool spans), Langfuse, HoneyHive

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Date Range]  [Tool ▼]  [Agent ▼]                               │
├──────────┬──────────┬──────────┬─────────────────────────────────┤
│ Tool Calls│ Success %│ Avg Lat  │ Retries                        │
│  1,892   │  94.2%   │  450ms   │  89                             │
├──────────┴──────────┴──────────┴─────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Tool Calls Over Time (Bar Chart, stacked success/fail)     │  │
│ └─────────────────────────────────────────────────────────────┘  │
├─────────────────────────────┬────────────────────────────────────┤
│ ┌─────────────────────────┐ │ ┌──────────────────────────────┐   │
│ │ Tool Success Rate       │ │ │ Latency by Tool              │   │
│ │ (Horizontal Bar Chart)  │ │ │ (Box Plot / Bar + P95 dots)  │   │
│ │ check_avail: ████ 98%   │ │ │ check_avail:  ██ 120ms       │   │
│ │ book_room:   ███  89%   │ │ │ book_room:    ████ 890ms     │   │
│ │ send_email:  ████ 96%   │ │ │ send_email:   ███ 340ms      │   │
│ └─────────────────────────┘ │ └──────────────────────────────┘   │
├─────────────────────────────┴────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Tool Performance Table                                     │  │
│ │  Tool Name    | Calls | Success | Avg Lat | P95   | Retries│  │
│ │  check_avail  | 892   | 98%     | 120ms   | 340ms | 12     │  │
│ │  book_room    | 423   | 89%     | 890ms   | 2.1s  | 42     │  │
│ │  send_email   | 312   | 96%     | 340ms   | 780ms | 8      │  │
│ └─────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Recent Failures (Table)                                    │  │
│ │  Time | Tool | Agent | Error Type | Error Message           │  │
│ └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

#### Data Sources

| Element              | Event Types                                                     |
| -------------------- | --------------------------------------------------------------- |
| KPI Cards            | `tool.call.completed`, `tool.call.failed`, `tool.call.retried`  |
| Calls Over Time      | `tool.call.completed`, `tool.call.failed` grouped by hour       |
| Success Rate by Tool | `tool.call.completed` + `tool.call.failed` grouped by tool_name |
| Latency by Tool      | `tool.call.completed` avg + p95 by tool_name                    |
| Tool Table           | All tool events aggregated                                      |
| Recent Failures      | `tool.call.failed` events, latest 20                            |

---

### Dashboard 7: Flow Execution (Unique to ABL)

**Route:** `/projects/:projectId/analytics/flows`
**Priority:** P2
**Industry precedent:** Voiceflow flow heatmaps (unique to our scripted agent model)

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Date Range]  [Agent ▼]                                         │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Flow Step Heatmap (Visual flow graph with traffic overlay) │  │
│ │                                                             │  │
│ │  [greeting] ──── 1,247 visits ────▶ [collect_info]          │  │
│ │       │                                    │                │  │
│ │      12% drop-off               ┌──────────┴──────┐        │  │
│ │                            [book_room]    [FAQ_lookup]      │  │
│ │                            423 visits     312 visits        │  │
│ │                                │               │            │  │
│ │                           [confirm]       [resolve]         │  │
│ │                           389 visits      298 visits        │  │
│ │                                                             │  │
│ │  Color intensity = visit count relative to entry            │  │
│ │  Red outline = high error rate at step                      │  │
│ └─────────────────────────────────────────────────────────────┘  │
├─────────────────────────────┬────────────────────────────────────┤
│ ┌─────────────────────────┐ │ ┌──────────────────────────────┐   │
│ │ Step Duration Table     │ │ │ Transition Frequency Table   │   │
│ │ Step     | Visits | Dur │ │ │ From → To    | Count | %     │   │
│ │ greeting | 1247   | 2s  │ │ │ greet→info   | 1098  | 88%   │   │
│ │ info     | 1098   | 8s  │ │ │ info→book    | 423   | 39%   │   │
│ │ book     | 423    | 3s  │ │ │ info→FAQ     | 312   | 28%   │   │
│ └─────────────────────────┘ │ └──────────────────────────────┘   │
├─────────────────────────────┴────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Gather Completion Funnel (Bar Chart)                       │  │
│ │  Fields collected: name ██████ 98% | date ████ 87% |        │  │
│ │  guests ███ 76% | room_type ████ 82%                        │  │
│ │  Correction rate: 12% (gather.correction.detected)          │  │
│ └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

#### Data Sources

| Element             | Event Types                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| Flow Step Heatmap   | `flow.step.entered`, `flow.step.exited` counts per step                    |
| Step Duration Table | `flow.step.exited` avg duration per step                                   |
| Transition Table    | `flow.transition` from_step → to_step counts                               |
| Gather Funnel       | `gather.field.extracted`, `gather.completed`, `gather.correction.detected` |

---

### Dashboard 8: Evaluations & Quality

**Route:** `/projects/:projectId/analytics/evaluations`
**Priority:** P2
**Industry precedent:** LangSmith, Langfuse, Braintrust, Phoenix, HoneyHive

#### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Date Range]  [Evaluator ▼]  [Agent ▼]                         │
├──────────┬──────────┬──────────┬─────────────────────────────────┤
│ Evals Run│ Avg Score│ Pass Rate│ Threshold Violations            │
│   342    │  0.82    │  91%     │  12                             │
├──────────┴──────────┴──────────┴─────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Quality Score Trend (Line Chart)                           │  │
│ │  Lines: overall, helpfulness, accuracy, safety              │  │
│ │  Horizontal threshold line at configured minimum            │  │
│ └─────────────────────────────────────────────────────────────┘  │
├─────────────────────────────┬────────────────────────────────────┤
│ ┌─────────────────────────┐ │ ┌──────────────────────────────┐   │
│ │ Score Distribution      │ │ │ Evaluator Results Table      │   │
│ │ (Histogram)             │ │ │ Evaluator  | Runs | Score    │   │
│ │ 0.0-0.2: ██  3%        │ │ │ helpful    | 342  | 0.87     │   │
│ │ 0.2-0.4: ███  5%       │ │ │ accurate   | 342  | 0.79     │   │
│ │ 0.4-0.6: █████ 12%     │ │ │ safe       | 342  | 0.96     │   │
│ │ 0.6-0.8: ████████ 35%  │ │ │ coherent   | 342  | 0.84     │   │
│ │ 0.8-1.0: █████████ 45% │ │ │                              │   │
│ └─────────────────────────┘ │ └──────────────────────────────┘   │
├─────────────────────────────┴────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Feedback Summary (when feedback.submitted events exist)    │  │
│ │  Thumbs Up: 89%  │  Avg Star Rating: 4.2/5                 │  │
│ │  Trend chart: feedback scores over time                     │  │
│ └─────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │  Recent Threshold Violations (Table)                        │  │
│ │  Time | Evaluator | Score | Threshold | Session | Agent     │  │
│ └─────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

#### Data Sources

| Element              | Event Types                                             |
| -------------------- | ------------------------------------------------------- |
| KPI Cards            | `evaluation.completed`, `evaluation.threshold.violated` |
| Quality Trend        | `evaluation.quality.scored` over time                   |
| Score Distribution   | `evaluation.quality.scored` score value histogram       |
| Evaluator Table      | `evaluation.completed` grouped by evaluator             |
| Feedback Summary     | `feedback.submitted` (rating_type, rating_value)        |
| Threshold Violations | `evaluation.threshold.violated` events                  |

---

## Part 3: Event Types → Dashboard Mapping

Complete mapping of all 47 event types to the dashboards that consume them:

| Event Type                      | Dashboard(s)                | Chart/Widget                           |
| ------------------------------- | --------------------------- | -------------------------------------- |
| `session.started`               | Overview, Sessions          | KPI card, session list, timeline       |
| `session.ended`                 | Overview, Sessions          | Session outcome breakdown              |
| `session.resumed`               | Sessions                    | Session status badge                   |
| `session.terminated`            | Sessions                    | Termination reason breakdown           |
| `session.updated`               | Sessions (detail)           | State change timeline                  |
| `message.user.received`         | Overview, Sessions          | Message count KPI, conversation replay |
| `message.agent.sent`            | Overview, Sessions          | Response time, conversation replay     |
| `llm.call.completed`            | Overview, LLM, Cost         | Latency, tokens, cost charts           |
| `llm.call.failed`               | Overview, LLM               | Error breakdown, error rate KPI        |
| `llm.model.resolved`            | LLM                         | Model resolution audit                 |
| `tool.call.completed`           | Overview, Tools             | Success rate, latency                  |
| `tool.call.failed`              | Overview, Tools             | Failure table, error breakdown         |
| `tool.call.retried`             | Tools                       | Retry count KPI                        |
| `tool.error.handled`            | Tools                       | Error handling success rate            |
| `agent.entered`                 | Overview, Agents            | Volume by agent, topology graph        |
| `agent.exited`                  | Agents                      | Duration, completion rate              |
| `agent.handoff`                 | Agents                      | Topology edges, Sankey diagram         |
| `agent.escalated`               | Agents                      | Escalation count, reason breakdown     |
| `agent.delegated`               | Agents                      | Delegation flow                        |
| `agent.fanout.completed`        | Agents                      | Fanout performance                     |
| `agent.decision`                | Agents (detail)             | Decision type breakdown                |
| `agent.constraint.checked`      | Agents (detail)             | Constraint violation timeline          |
| `gather.field.extracted`        | Flows                       | Gather funnel completion               |
| `gather.field.validated`        | Flows                       | Validation success rate                |
| `gather.completed`              | Flows                       | Gather completion rate                 |
| `gather.correction.detected`    | Flows                       | Correction rate metric                 |
| `flow.step.entered`             | Flows                       | Step heatmap, visit counts             |
| `flow.step.exited`              | Flows                       | Step duration                          |
| `flow.transition`               | Flows                       | Transition frequency table             |
| `channel.message.received`      | Overview                    | Channel volume breakdown               |
| `channel.message.sent`          | Overview                    | Channel response metrics               |
| `channel.webhook.delivered`     | (Channel dashboard, future) | Webhook success rate                   |
| `deployment.created`            | (Deployments page)          | Deployment timeline                    |
| `deployment.retired`            | (Deployments page)          | Deployment lifecycle                   |
| `deployment.rolled_back`        | (Deployments page)          | Rollback frequency                     |
| `evaluation.started`            | Evaluations                 | Eval run count                         |
| `evaluation.completed`          | Evaluations                 | Pass rate, evaluator table             |
| `evaluation.failed`             | Evaluations                 | Eval failure rate                      |
| `evaluation.batch.completed`    | Evaluations                 | Batch summary                          |
| `evaluation.threshold.violated` | Evaluations                 | Violation alerts                       |
| `evaluation.quality.scored`     | Evaluations                 | Score trend, distribution              |
| `evaluation.sentiment.analyzed` | Evaluations                 | Sentiment trend                        |
| `evaluation.summary.generated`  | Evaluations                 | Summary card                           |
| `feedback.submitted`            | Evaluations                 | Feedback score trend, rating breakdown |
| `auth.login`                    | (Audit page, future)        | Auth event timeline                    |
| `auth.token.created`            | (Audit page, future)        | Token creation audit                   |

---

## Part 4: Implementation Approach

### What Already Exists

| Component                           | Status              | Location                                                   |
| ----------------------------------- | ------------------- | ---------------------------------------------------------- |
| **Recharts** (charting library)     | Installed           | `apps/studio/package.json`                                 |
| **BillingPage** (dashboard pattern) | Working reference   | Uses AreaChart, PieChart, summary cards, date range picker |
| **Analytics API** (8 endpoints)     | Built               | `apps/runtime/src/routes/analytics.ts`                     |
| **EventQueryService**               | Built               | `packages/eventstore/src/query/`                           |
| **SWR data fetching**               | Established pattern | Throughout Studio                                          |
| **Observatory** (trace viewer)      | Built               | Timeline, span tree, state machine, agent flow graph       |
| **Design system**                   | Mature              | Semantic colors, badges, cards, skeletons                  |
| **Sigma graph library**             | Installed           | For agent topology visualization                           |
| **Dagre layout engine**             | Installed           | For flow graph layouts                                     |

### Recommended Build Order

| Phase       | Dashboard                             | Why First                                                                                          |
| ----------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Phase 1** | Overview + Sessions + LLM Performance | These 3 cover 80% of daily use. Helicone/Langfuse analytics show these are the most-visited pages. |
| **Phase 2** | Cost & Usage + Agent Performance      | Cost is critical for budget management. Agents is unique to multi-agent platforms.                 |
| **Phase 3** | Tools + Flows + Evaluations           | Deeper drill-downs. Flows is unique to our scripted agent model.                                   |

### Component Architecture

```
apps/studio/src/app/projects/[projectId]/analytics/
├── page.tsx                    # Overview dashboard
├── sessions/
│   ├── page.tsx                # Session list
│   └── [sessionId]/page.tsx    # Session detail
├── llm/page.tsx                # LLM performance
├── cost/page.tsx               # Cost & usage
├── agents/page.tsx             # Agent performance
├── tools/page.tsx              # Tool analytics
├── flows/page.tsx              # Flow execution
└── evaluations/page.tsx        # Quality & feedback

apps/studio/src/components/analytics/
├── KPICard.tsx                 # Reusable stat card with trend arrow
├── TimeRangeSelector.tsx       # Date range picker (24h/7d/30d/custom)
├── EventVolumeChart.tsx        # Stacked area chart for event volume
├── LatencyTrendChart.tsx       # Line chart for avg/p95 latency
├── CostBreakdownPie.tsx        # Pie/donut chart for cost by model
├── AgentTopologyGraph.tsx      # Sigma-based agent interaction graph
├── FlowHeatmap.tsx             # Dagre-based flow step heatmap
├── SessionTimeline.tsx         # Trace waterfall for session detail
├── ErrorsTable.tsx             # Recent errors table
└── MetricsTable.tsx            # Sortable metrics table

apps/studio/src/hooks/
├── useAnalyticsMetrics.ts      # SWR hook for /analytics/metrics
├── useAnalyticsEvents.ts       # SWR hook for /analytics/events
├── useSessionMetrics.ts        # SWR hook for /analytics/session-metrics
├── useCostBreakdown.ts         # SWR hook for /analytics/cost-breakdown
└── useAgentPerformance.ts      # SWR hook for /analytics/agents/:name
```

### Shared Components Spec

**KPICard** — Reusable stat card (used on every dashboard):

```tsx
<KPICard
  label="Total Sessions"
  value={1247}
  format="number" // number | currency | percent | duration
  trend={+12} // % change vs previous period
  trendDirection="up" // up | down | neutral
  icon={<Activity />}
/>
```

**TimeRangeSelector** — Date range picker (top of every dashboard):

```tsx
<TimeRangeSelector
  presets={['24h', '7d', '30d', '90d']}
  value={timeRange}
  onChange={setTimeRange}
  autoRefresh={true} // optional auto-refresh toggle
  refreshInterval={30000} // 30s default
/>
```

### API Gaps to Fill

The existing analytics API covers most needs. Two new endpoints would help:

1. **`GET /analytics/top-sessions`** — Returns sessions ranked by cost, duration, or error count. Needed for "Top Cost Sessions" table on Cost dashboard.
2. **`GET /analytics/agent-topology`** — Pre-computed handoff graph (from_agent → to_agent with counts). Could be built client-side from `agent.handoff` events but a server-side aggregation is more efficient.

### EventCategorySchema Update Needed

The analytics route's `EventCategorySchema` at `analytics.ts:60` is missing the new `message` and `feedback` categories:

```typescript
// Current (incomplete):
const EventCategorySchema = z.enum([
  'session',
  'llm',
  'tool',
  'agent',
  'gather',
  'flow',
  'channel',
  'deployment',
  'search',
  'voice',
  'audit',
  'system',
]);

// Should be:
const EventCategorySchema = z.enum([
  'session',
  'message',
  'llm',
  'tool',
  'agent',
  'gather',
  'flow',
  'channel',
  'deployment',
  'search',
  'voice',
  'audit',
  'evaluation',
  'feedback',
  'system',
]);
```

---

## Part 5: Unique Differentiators (What No Other Platform Has)

Our platform has several unique angles that no competitor covers:

### 5.1 Scripted Flow Analytics

No other observability platform (LangSmith, Langfuse, Helicone, etc.) understands scripted agent flows. They only see "chains" as generic spans. We can show:

- **Flow step heatmaps** with traffic volume overlay
- **Gather completion funnels** — how many users complete all required fields
- **Transition frequency analysis** — which paths through the flow are most common
- **Drop-off detection** — where in the flow users abandon

### 5.2 Multi-Agent Orchestration View

AgentOps has basic multi-agent tracking, but our supervisor/delegate/handoff model is richer:

- **Supervisor routing analysis** — how the supervisor distributes work
- **Handoff chain visualization** — full path: triage → booking → confirmation
- **Delegation success rates** — which delegated tasks succeed vs. fail
- **Fanout analytics** — parallel delegation performance

### 5.3 Constraint Violation Analytics

No other platform tracks agent behavioral constraints. We can show:

- Which constraints fire most often
- Pass/fail rates per constraint
- Correlation between constraint violations and session outcomes
- Constraint violation trends over deployment versions

### 5.4 Gather Intelligence

No competitor tracks data collection quality at the field level:

- Per-field extraction success rates
- Correction rates (user fixed what the agent extracted)
- Validation pass/fail rates
- Average turns to complete a gather sequence

---

## Part 6: Industry Best Practices Summary

### Real-Time vs. Historical

- **Real-time** (< 30s lag): Error alerts, active session count, current throughput. Use WebSocket or short-poll (5-30s SWR refresh).
- **Historical** (1min+ lag): Cost trends, quality scores, model comparison. Standard page-load queries with caching (60s TTL via our EventStore cache).

### Time Range Defaults

- Default to **last 24 hours** (industry standard across all platforms)
- Presets: 1h, 24h, 7d, 30d, 90d, Custom
- Comparison toggle: "vs. previous period" for trend calculation

### Chart Type Selection Guide

| Data Pattern         | Chart Type      | Example                                  |
| -------------------- | --------------- | ---------------------------------------- |
| Metric over time     | Area/Line chart | Latency trend, cost trend                |
| Category breakdown   | Pie/Donut chart | Cost by model, events by category        |
| Ranked comparison    | Horizontal bar  | Top agents, tool success rates           |
| Distribution         | Histogram       | Score distribution, latency distribution |
| Flow/relationships   | Sankey / Graph  | Agent handoffs, flow transitions         |
| Multi-dimensional    | Sortable table  | Model comparison, tool performance       |
| Traffic on structure | Heatmap overlay | Flow step visit counts                   |

### Data Density Guidelines (from Helicone/Langfuse patterns)

- **KPI Cards**: Max 6 per row, show value + trend arrow + sparkline
- **Charts**: Max 2-3 per row, responsive grid
- **Tables**: Paginated (25/50/100 per page), sortable columns, clickable rows for drill-down
- **Filters**: Top bar with dropdowns, persist in URL query params for shareability

---

## Part 7: Cross-Platform Feature Comparison Tables

### 7.1 Overview Dashboard — Feature Matrix

| Metric                | LangSmith | Langfuse      | Helicone | Portkey | Lunary | AgentOps | Braintrust |
| --------------------- | --------- | ------------- | -------- | ------- | ------ | -------- | ---------- |
| Total Requests/Traces | Yes       | Yes           | Yes      | Yes     | Yes    | Yes      | Yes        |
| Total Cost (USD)      | Yes       | Yes           | Yes      | Yes     | Yes    | Yes      | Yes        |
| Mean/P50/P95 Latency  | Yes       | Yes           | Yes      | Yes     | Yes    | No       | Yes        |
| Token Usage (in/out)  | Yes       | Yes           | Yes      | Yes     | Yes    | Yes      | Yes        |
| Error Rate            | Yes       | Yes           | Yes      | Yes     | Yes    | No       | Yes        |
| Active Users          | No        | Via user dim  | Yes      | Yes     | No     | No       | No         |
| Top Models            | No        | Via model dim | Yes      | Yes     | Yes    | No       | No         |
| TTFT                  | No        | Yes           | Yes      | Yes     | No     | No       | No         |
| Cache Hit Rate        | No        | No            | Yes      | Yes     | No     | No       | No         |

### 7.2 Trace View — Feature Matrix

| Feature                    | LangSmith                   | Langfuse     | Helicone      | Phoenix      | AgentOps    | HoneyHive    |
| -------------------------- | --------------------------- | ------------ | ------------- | ------------ | ----------- | ------------ |
| Span tree / hierarchy      | Yes                         | Yes          | Path-based    | Yes          | Waterfall   | Graph view   |
| Waterfall timeline         | Yes                         | Yes          | No            | Yes          | Yes         | Yes          |
| Full I/O inspection        | Yes                         | Yes          | Yes           | Yes          | Yes         | Yes          |
| Span kinds (LLM/Tool/etc.) | Chain, LLM, Tool, Retriever | LLM, Tool    | Request-based | 7 span kinds | Event types | Distributed  |
| Cost per span              | Yes                         | Yes          | Yes           | Yes          | Yes         | Yes          |
| Annotations on spans       | Yes (queues)                | Yes (scores) | Yes (scores)  | Yes          | No          | Yes (queues) |
| AI-powered trace analysis  | Polly AI                    | No           | No            | No           | No          | No           |
| Semantic search            | No                          | No           | No            | No           | No          | No           |
| Span replay in playground  | No                          | No           | No            | Yes          | No          | Yes          |

### 7.3 Cost Analytics — Advanced Features

| Feature                                        | Platforms That Support It                            |
| ---------------------------------------------- | ---------------------------------------------------- |
| Cost breakdown by prompt vs. completion tokens | LangSmith, Langfuse, Portkey                         |
| Cost per user                                  | Langfuse, Helicone, Portkey                          |
| Cost per feature/use-case                      | Langfuse (via trace name), Braintrust (via tags)     |
| Cache cost savings                             | Portkey (dedicated tab), Helicone                    |
| Cost per session                               | Langfuse, Helicone                                   |
| Budget limits / alerts                         | Portkey (budget limits on API keys)                  |
| Custom model pricing                           | OpenLIT (custom pricing files for fine-tuned models) |
| Cost per experiment/version                    | Langfuse, Braintrust, W&B Weave                      |
| Cost projection (estimated monthly)            | Portkey                                              |

### 7.4 Quality & Evaluation — Score Types

| Score Type           | Langfuse | LangSmith          | Helicone      | HoneyHive     | Braintrust     | Lunary            |
| -------------------- | -------- | ------------------ | ------------- | ------------- | -------------- | ----------------- |
| Numeric scores       | Yes      | Yes                | Yes (integer) | Yes           | Yes            | Yes               |
| Categorical scores   | Yes      | Yes                | No            | Yes           | Yes            | No                |
| Boolean (pass/fail)  | Yes      | No                 | Yes           | Yes           | Yes            | No                |
| LLM-as-Judge         | Via SDK  | Online evaluations | External      | 25+ pre-built | Online scoring | No                |
| Human annotation     | Yes      | Annotation queues  | Manual entry  | Review queues | Yes            | Human reviews     |
| User feedback        | Yes      | Yes                | Via API       | Yes           | Yes            | Feedback tracking |
| Regression detection | No       | No                 | No            | Yes (drift)   | Yes (online)   | No                |
| Topic classification | No       | No                 | No            | No            | Yes (AI)       | Yes (auto)        |

### 7.5 Agent & Multi-Agent Features

| Feature                      | AgentOps          | HoneyHive     | LangSmith    | Phoenix        | CrewAI             |
| ---------------------------- | ----------------- | ------------- | ------------ | -------------- | ------------------ |
| Multi-agent graph view       | Session waterfall | Graph view    | Trace tree   | Span hierarchy | Task graph         |
| Handoff tracking             | Via events        | Yes (A2A/MCP) | Via spans    | Via spans      | Via crew execution |
| Session state (Success/Fail) | Yes               | No            | No           | No             | No                 |
| Time-travel debugging        | Yes               | No            | No           | Span replay    | No                 |
| Framework-aware (auto)       | CrewAI, AutoGen   | MCP, A2A      | LangChain    | OpenInference  | CrewAI native      |
| Per-agent metrics            | Basic             | Yes           | Via run type | Via span kind  | Via task metrics   |
| Agent routing analysis       | No                | Yes           | No           | No             | No                 |

### 7.6 Session / Conversation Features

| Feature                           | Langfuse      | Helicone             | AgentOps   | Lunary     | Voiceflow       |
| --------------------------------- | ------------- | -------------------- | ---------- | ---------- | --------------- |
| Session grouping                  | By session ID | Path-based hierarchy | By session | By session | By conversation |
| Chat replay                       | No            | No                   | Yes        | Yes        | Yes             |
| Session metrics (duration, turns) | Yes           | Yes                  | Yes        | Yes        | Yes             |
| Session cost                      | Yes           | Yes                  | Yes        | No         | No              |
| Conversation funnel/drop-off      | No            | No                   | No         | No         | Yes             |
| Flow step analytics               | No            | No                   | No         | No         | Yes (heatmap)   |

### 7.7 Alert & Monitoring Capabilities

| Platform   | Error Rate Alerts      | Latency Alerts | Cost/Budget Alerts | Quality Score Alerts  | Anomaly Detection |
| ---------- | ---------------------- | -------------- | ------------------ | --------------------- | ----------------- |
| LangSmith  | Via rules/webhooks     | Via rules      | No                 | Online evaluations    | No                |
| Langfuse   | Via export to PostHog  | Via export     | No                 | Score thresholds      | No                |
| Helicone   | Yes                    | Yes            | Yes                | No                    | No                |
| Portkey    | Yes                    | Yes            | Yes (budget caps)  | No                    | No                |
| HoneyHive  | Yes (silent failures)  | No             | No                 | Yes (drift detection) | Yes (drift)       |
| Braintrust | No                     | No             | No                 | Yes (score decline)   | No                |
| Lunary     | Yes (underperformance) | No             | No                 | No                    | No                |

### 7.8 Unique/Innovative Features by Platform

| Platform       | Unique Feature           | Description                                                              |
| -------------- | ------------------------ | ------------------------------------------------------------------------ |
| **LangSmith**  | Polly AI Assistant       | AI-powered analysis of traces — ask questions about agent behavior       |
| **Langfuse**   | PostHog Integration      | Export LLM metrics to product analytics for business correlation         |
| **Helicone**   | User Segmentation        | Auto-classify users into Power/Casual/New/At-Risk cohorts                |
| **Helicone**   | Cache Analytics          | Dedicated dashboard for cache hit rates, latency savings, cost savings   |
| **Portkey**    | Rescued Requests         | Metric showing requests saved by gateway fallback/retry strategies       |
| **Portkey**    | Budget Caps              | Automatic request blocking when API key budget is exceeded               |
| **AgentOps**   | Time-Travel Debugging    | Step-by-step replay of agent execution with state snapshots              |
| **HoneyHive**  | 25+ Pre-built Evaluators | Out-of-box quality evaluators (hallucination, toxicity, relevance, etc.) |
| **HoneyHive**  | Drift Detection          | Monitors for gradual quality degradation over time                       |
| **Braintrust** | Topics (AI)              | Auto-extract intent, sentiment, and issues from traces using AI          |
| **Braintrust** | Loop (NL-to-SQL)         | Natural language interface to query trace data                           |
| **Lunary**     | PII Masking              | Automatic PII detection and masking in the observability layer           |
| **Lunary**     | Language Detection       | Auto-detect user language from conversation content                      |
| **Phoenix**    | Span Replay              | Re-execute specific LLM calls in playground for debugging                |
| **OpenLIT**    | GPU Monitoring           | First-class GPU metrics alongside LLM observability                      |
| **Voiceflow**  | Flow Heatmaps            | Traffic overlay on visual conversation flow steps                        |
| **Voiceflow**  | Drop-off Analysis        | Funnel showing where users abandon conversations per flow step           |

---

## Part 8: Recommended Minimum Dashboard Set

Based on the cross-platform analysis, here is the industry-standard minimum set:

| #   | Dashboard                                     | Every Platform Has It?                    | Priority for Us       |
| --- | --------------------------------------------- | ----------------------------------------- | --------------------- |
| 1   | **Overview** (KPIs + trends)                  | Yes — all 12                              | P0                    |
| 2   | **Sessions** (list + detail + replay)         | 10 of 12                                  | P0                    |
| 3   | **LLM Performance** (latency + tokens + cost) | 11 of 12                                  | P0                    |
| 4   | **Cost & Usage** (budget + breakdown)         | 9 of 12                                   | P1                    |
| 5   | **Agents** (topology + handoffs)              | 5 of 12 (emerging)                        | P1                    |
| 6   | **Tools** (success rate + latency)            | 7 of 12                                   | P2                    |
| 7   | **Flows** (heatmap + gather funnel)           | 1 of 12 (Voiceflow only)                  | P2 — **unique to us** |
| 8   | **Evaluations** (scores + feedback)           | 8 of 12                                   | P2                    |
| 9   | **Errors** (breakdown + recent failures)      | 8 of 12                                   | P2                    |
| 10  | **Alerts** (threshold config)                 | 7 of 12                                   | P3                    |
| 11  | **Users** (per-user analytics)                | 4 of 12                                   | P3                    |
| 12  | **Experiments** (A/B comparison)              | 6 of 12                                   | P3                    |
| 13  | **Custom Dashboards** (user-built)            | 3 of 12 (LangSmith, Braintrust, Langfuse) | P4                    |
