# Analytics Gap Analysis: Current State vs. 7-Tier Vision

> Prepared: 2026-02-27 | Branch: `events_architecture`
> Compares what's built in `@abl/eventstore` + runtime integration against the full analytics vision in `analytics-metrics-insights-market-research.md`.

---

## Legend

| Symbol    | Meaning                                      |
| --------- | -------------------------------------------- |
| `BUILT`   | Fully implemented and tested                 |
| `PARTIAL` | Infrastructure exists but feature incomplete |
| `MISSING` | Not yet implemented                          |

---

## Executive Summary

**What we have:** A solid event infrastructure layer — 40+ event schemas, ClickHouse storage, pluggable queues (Direct/BullMQ/Kafka), 3-level resilient emitter, retention, GDPR, webhooks, trace bridge dual-write, cascade delete hooks, and factory. This is the **data plumbing** — events can flow, be stored, queried, retained, and deleted.

**What we don't have:** Everything that _consumes_ events to produce analytics, intelligence, and insights. No dashboards, no LLM-as-judge pipeline, no sentiment analysis, no anomaly detection, no NL-to-SQL interface, no conversation search, no evaluation dispatcher, no SDK event emission API, no DSL `emit` blocks, no OTel integration.

**Estimated coverage by tier:**

| Tier                                     | Coverage | Notes                                                                             |
| ---------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| Tier 1: Operational Observability        | ~25%     | Event schemas exist; no OTel, no dashboards, no drift detection                   |
| Tier 2: Agent Performance Analytics      | ~15%     | Event types for agent/tool/LLM exist; no aggregation, no LLM-judge, no metrics    |
| Tier 3: Conversation & Quality Analytics | ~5%      | No quality evaluation, no sentiment, no helpfulness, no summarization             |
| Tier 4: Business Outcome Analytics       | ~5%      | Session events exist; no containment tracking, no voice, no ROI                   |
| Tier 5: Custom Event Emission            | ~20%     | Unified event model exists; no SDK emit API, no DSL emit blocks, no eval pipeline |
| Tier 6: AI-Powered Insights              | ~0%      | Nothing built                                                                     |
| Tier 7: Analytics Data Platform          | ~10%     | ClickHouse store + query service exist; no dashboards, no NL-to-SQL, no search    |

---

## Tier 1: Operational Observability

### 1.1 End-to-End Tracing

| Feature                                                  | Status    | What Exists                                                                                                                                                 | Gap                                                                                                                                                                      |
| -------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hierarchical span structure (Session → Agent → LLM/Tool) | `PARTIAL` | TraceStore has flat events with `spanId`/`parentSpanId`. TraceEmitter emits `agent_enter`, `agent_exit`, `flow_step_enter/exit`, `delegate_start/complete`. | Not OTel-native. No OTel SDK integration, no W3C trace context propagation, no OTel collector export. Span hierarchy is implicit (parent pointers) not structured spans. |
| OTel GenAI Semantic Conventions                          | `MISSING` | —                                                                                                                                                           | No `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` attributes. No OTel span kinds (CHAIN, LLM, TOOL, RETRIEVER, etc.).                              |
| 10 span kinds                                            | `PARTIAL` | Trace events cover: LLM, TOOL, AGENT, HANDOFF, FLOW_STEP, DELEGATE.                                                                                         | Missing: CHAIN, RETRIEVER, EMBEDDING, RERANKER, GUARDRAIL, EVALUATOR spans.                                                                                              |
| Cross-agent context propagation                          | `PARTIAL` | `spanStack` in trace emitter tracks parent-child.                                                                                                           | No W3C traceparent propagation across service boundaries or multi-agent handoffs.                                                                                        |

### 1.2 Latency & Performance

| Feature                        | Status    | What Exists                                                                                   | Gap                                                                                                                  |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| End-to-end latency P50/P95/P99 | `PARTIAL` | `duration_ms` on trace events and platform events.                                            | No percentile aggregation queries, no pre-computed materialized views for latency percentiles, no dashboard widgets. |
| Time to First Token (TTFT)     | `MISSING` | —                                                                                             | Not tracked. Requires streaming-aware instrumentation in LLM provider.                                               |
| LLM call duration              | `BUILT`   | `llm.call.completed` event has `latency_ms`. TraceEmitter `logLLMCall` records `latencyMs`.   | ✓ Data is captured. Needs aggregation/visualization.                                                                 |
| Tool execution duration        | `BUILT`   | `tool.call.completed` event has `latency_ms`. TraceEmitter `logToolCall` records `latencyMs`. | ✓ Data is captured. Needs aggregation/visualization.                                                                 |
| Retrieval latency              | `PARTIAL` | `search.query.executed` event has `latency_ms`.                                               | No retriever span breakdown (query → rerank → return).                                                               |
| Voice latency (TTFB, TTFA)     | `MISSING` | `voice.session.created/ended` schemas exist.                                                  | No TTFB, TTFA, end-to-end voice latency tracking.                                                                    |

### 1.3 Token Usage & Cost Attribution

| Feature                                  | Status    | What Exists                                                                                                      | Gap                                                                               |
| ---------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Per-model token tracking                 | `BUILT`   | `llm.call.completed` has `input_tokens`, `output_tokens`, `total_tokens`, `estimated_cost`, `model`, `provider`. | ✓ Data captured.                                                                  |
| Cost attribution by tenant/project/agent | `PARTIAL` | Events carry `tenant_id`, `project_id`, `agent_name`. `EventQueryService.getCostBreakdown()` exists.             | No per-intent, per-customer-segment, per-tool cost attribution. No budget alerts. |
| Budget alerts and spend tracking         | `MISSING` | —                                                                                                                | No budget configuration, no alert engine, no spend dashboards.                    |

### 1.4 Error Rates & System Health

| Feature                      | Status    | What Exists                                                                      | Gap                                                  |
| ---------------------------- | --------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| LLM API error rates          | `BUILT`   | `llm.call.failed` event with `error_type`, `error_message`, `provider`, `model`. | ✓ Data captured. Needs aggregation dashboard.        |
| Tool execution failure rates | `BUILT`   | `tool.call.failed` event with `error_type`, `tool_name`.                         | ✓ Data captured.                                     |
| Guardrail trigger rates      | `PARTIAL` | `agent.constraint.checked` event with `passed`/`violation_type`.                 | No dedicated guardrail span type. No FP/FN tracking. |
| Rate limit events            | `MISSING` | —                                                                                | No rate limit event schema.                          |
| Voice error rates            | `MISSING` | —                                                                                | No ASR error, TTS failure, codec issue tracking.     |

### 1.5 Model/Provider Drift Detection

| Feature                         | Status    | What Exists                           | Gap                                                                       |
| ------------------------------- | --------- | ------------------------------------- | ------------------------------------------------------------------------- |
| Input/output distribution drift | `MISSING` | —                                     | No embedding capture, no KL divergence computation, no drift dashboard.   |
| Prompt drift                    | `MISSING` | —                                     | No baseline prompt fingerprinting, no drift detection.                    |
| Model degradation detection     | `MISSING` | —                                     | No quality score trending over time per model.                            |
| Provider availability           | `PARTIAL` | `llm.call.failed` events by provider. | No health check monitoring, no uptime tracking, no fallback trigger rate. |
| Semantic entropy                | `MISSING` | —                                     | No multi-sample consistency scoring.                                      |

### 1.6 Real-Time Dashboard

| Feature                     | Status    | What Exists | Gap                                                                |
| --------------------------- | --------- | ----------- | ------------------------------------------------------------------ |
| Active conversations widget | `MISSING` | —           | No real-time session count.                                        |
| Error rate rolling window   | `MISSING` | —           | No pre-computed rolling aggregations.                              |
| Avg response latency widget | `MISSING` | —           | No dashboard infrastructure at all.                                |
| Escalation rate widget      | `MISSING` | —           | —                                                                  |
| Token spend rate widget     | `MISSING` | —           | —                                                                  |
| Top intents widget          | `MISSING` | —           | No intent classification/tracking system.                          |
| Provider status widget      | `MISSING` | —           | —                                                                  |
| Dashboard infrastructure    | `MISSING` | —           | No dashboard framework, no widget system, no real-time data feeds. |

**Tier 1 Summary:** Data capture infrastructure is solid (events with timestamps, durations, errors, costs all flow to ClickHouse). The gap is: (a) OTel-native instrumentation, (b) aggregation/materialized views, (c) dashboard UI, (d) drift detection algorithms.

---

## Tier 2: Agent Performance Analytics

### 2.1 Quantitative Metrics

| Feature                            | Status    | What Exists                                                        | Gap                                                                |
| ---------------------------------- | --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Invocation count per agent         | `PARTIAL` | `agent.entered` events. `EventQueryService.count()` can aggregate. | No pre-built query or dashboard.                                   |
| Step execution count               | `PARTIAL` | `flow.step.entered` events.                                        | No aggregation.                                                    |
| Tool invocation count/success rate | `PARTIAL` | `tool.call.completed`/`failed` events.                             | No per-agent tool metrics rollup.                                  |
| Avg steps/turns per conversation   | `MISSING` | —                                                                  | No session-level metric aggregation.                               |
| Containment/escalation rates       | `PARTIAL` | `session.ended` has `reason`. `agent.escalated` events exist.      | No containment rate computation (requires outcome classification). |
| Error rate per agent               | `PARTIAL` | Events carry `agent_name` + `has_error`.                           | No pre-built agent error rate query.                               |
| Cost per invocation                | `PARTIAL` | LLM cost events carry `agent_name`.                                | No per-invocation cost rollup.                                     |

### 2.2 Qualitative Metrics (LLM-as-Judge)

| Feature                     | Status    | What Exists | Gap                                                                         |
| --------------------------- | --------- | ----------- | --------------------------------------------------------------------------- |
| Goal completion             | `MISSING` | —           | No LLM-as-judge evaluation pipeline at all. This is the single largest gap. |
| Topic adherence             | `MISSING` | —           | —                                                                           |
| Instruction following       | `MISSING` | —           | —                                                                           |
| Response relevance/accuracy | `MISSING` | —           | —                                                                           |
| Message tonality            | `MISSING` | —           | —                                                                           |
| Empathy score               | `MISSING` | —           | —                                                                           |
| Safety compliance           | `MISSING` | —           | —                                                                           |
| Helpfulness score           | `MISSING` | —           | —                                                                           |

### 2.3 Tool Usage Effectiveness

| Feature                     | Status    | What Exists                                                     | Gap                                                           |
| --------------------------- | --------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| Tool selection accuracy     | `MISSING` | —                                                               | Requires ground-truth or LLM judge to determine "right tool." |
| Parameter accuracy          | `MISSING` | —                                                               | No parameter validation scoring.                              |
| Tool retry rate             | `PARTIAL` | `tool.call.retried` event exists with `attempt`, `max_retries`. | No aggregation/analysis.                                      |
| Tool call sequence accuracy | `MISSING` | —                                                               | No multi-tool workflow ordering analysis.                     |
| Tool call efficiency        | `MISSING` | —                                                               | No optimal-vs-actual comparison.                              |
| Unused tool rate            | `MISSING` | —                                                               | No tool utilization analysis.                                 |

### 2.4 Reasoning Quality

| Feature                               | Status    | What Exists                                              | Gap                                         |
| ------------------------------------- | --------- | -------------------------------------------------------- | ------------------------------------------- |
| Reasoning coherence score             | `MISSING` | —                                                        | Requires LLM judge over reasoning traces.   |
| Decision confidence calibration (ECE) | `MISSING` | —                                                        | No confidence capture or calibration.       |
| Self-correction rate                  | `MISSING` | —                                                        | No self-correction detection.               |
| Planning effectiveness                | `MISSING` | —                                                        | —                                           |
| Routing decision precision            | `PARTIAL` | `agent.decision` events with `decision_type: 'routing'`. | No precision measurement (no ground truth). |

### 2.5 RAG / Knowledge Retrieval Metrics

| Feature                                | Status    | What Exists                                 | Gap                                                          |
| -------------------------------------- | --------- | ------------------------------------------- | ------------------------------------------------------------ |
| Retrieval precision@K / recall@K / MRR | `PARTIAL` | `search.query.executed` has `result_count`. | No relevance annotation, no precision/recall computation.    |
| Context utilization                    | `MISSING` | —                                           | No tracking of which retrieved chunks are used in responses. |
| Knowledge base coverage                | `MISSING` | —                                           | —                                                            |
| Citation coverage                      | `MISSING` | —                                           | —                                                            |
| Stale knowledge rate                   | `MISSING` | —                                           | —                                                            |

### 2.6 Extraction & Gathering (ABL-specific)

| Feature                 | Status    | What Exists                                                  | Gap                                          |
| ----------------------- | --------- | ------------------------------------------------------------ | -------------------------------------------- |
| Extraction accuracy     | `PARTIAL` | `gather.field.extracted` event exists.                       | No accuracy evaluation against ground truth. |
| Extraction completeness | `PARTIAL` | `gather.completed` has `fields_collected`.                   | No completeness analysis.                    |
| Extraction efficiency   | `PARTIAL` | `gather.completed` has `duration_ms`, `extraction_attempts`. | No optimal-vs-actual comparison.             |
| Clarification rate      | `PARTIAL` | `gather.completed` has `clarification_count`.                | No analysis/benchmarking.                    |

### 2.7 Multi-Agent Coordination

| Feature                    | Status    | What Exists                                          | Gap                                |
| -------------------------- | --------- | ---------------------------------------------------- | ---------------------------------- |
| Handoff accuracy           | `PARTIAL` | `agent.handoff` events with `from_agent`/`to_agent`. | No accuracy evaluation.            |
| Handoff latency            | `MISSING` | —                                                    | No queue/routing time measurement. |
| Context preservation score | `MISSING` | —                                                    | —                                  |
| Resolution depth           | `MISSING` | —                                                    | No agent-chain-length tracking.    |
| Redundant work rate        | `MISSING` | —                                                    | —                                  |

**Tier 2 Summary:** Event schemas exist for most agent/tool/LLM activities. The critical gap is the **LLM-as-judge evaluation pipeline** — no infrastructure for running qualitative evaluations on conversations. Also missing: aggregation queries, per-agent dashboards, and benchmarking.

---

## Tier 3: Conversation & Quality Analytics

| Feature                               | Status    | What Exists                               | Gap                                                                                      |
| ------------------------------------- | --------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| 100% conversation quality evaluation  | `MISSING` | —                                         | No evaluation pipeline, no quality scoring, no CX score.                                 |
| Helpfulness scoring                   | `MISSING` | —                                         | No information gain, task progression, wasted turn analysis.                             |
| User struggle/friction detection      | `MISSING` | —                                         | No behavioral signal detection (rephrasing, message length trend, frustration language). |
| Sentiment analysis & progression      | `MISSING` | —                                         | No sentiment model integration.                                                          |
| Multi-turn memory & consistency       | `MISSING` | —                                         | No contradiction detection, no memory recall accuracy tracking.                          |
| Topic/intent distribution & discovery | `MISSING` | —                                         | No intent classification, no unsupervised topic discovery.                               |
| Conversation flow analysis            | `MISSING` | —                                         | No path analysis, drop-off funnels, loop detection, Sankey visualization.                |
| Safety/guardrail effectiveness        | `PARTIAL` | `agent.constraint.checked` with `passed`. | No FP/FN rate tracking, no bypass detection.                                             |
| Hallucination & accuracy              | `MISSING` | —                                         | No faithfulness scoring, no SelfCheckGPT, no NLI-based groundedness.                     |
| Conversation summarization            | `MISSING` | —                                         | No async summarization pipeline.                                                         |
| Conversation tagging & classification | `MISSING` | —                                         | No tag system, no auto-classification rules engine.                                      |
| Custom topic taxonomies               | `MISSING` | —                                         | No hierarchical taxonomy builder.                                                        |

**Tier 3 Summary:** Almost entirely unbuilt. This tier requires: (a) an async evaluation dispatcher, (b) LLM-as-judge integration, (c) sentiment models, (d) conversation summarizer, (e) tagging engine. Heavy AI/ML work.

---

## Tier 4: Business Outcome Analytics

| Feature                                         | Status    | What Exists                                       | Gap                                                                                                                   |
| ----------------------------------------------- | --------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Containment rate                                | `PARTIAL` | `session.ended` with `reason`.                    | No outcome classification. No containment vs. deflection distinction.                                                 |
| Deflection rate                                 | `MISSING` | —                                                 | Requires counterfactual estimation.                                                                                   |
| First Contact Resolution (FCR)                  | `MISSING` | —                                                 | Requires repeat-contact detection within 24-72h window.                                                               |
| Avg handle time                                 | `PARTIAL` | `session.ended` has `total_duration_ms`.          | No per-intent breakdown.                                                                                              |
| Drop-off/abandonment                            | `PARTIAL` | `session.ended` `reason` includes termination.    | No abandonment rate dashboard.                                                                                        |
| Customer effort score                           | `MISSING` | —                                                 | Requires post-interaction survey or AI inference.                                                                     |
| Granular outcome classification (10 categories) | `MISSING` | —                                                 | No outcome classifier. `session.ended.reason` is basic.                                                               |
| Voice metrics (WER, MOS, TTFA, etc.)            | `MISSING` | Event schemas `voice.session.*` exist (2 events). | No WER, MOS, TTFB, TTFA, barge-in, dead air, turn-taking metrics. Need 15+ voice event schemas + ASR/TTS integration. |
| Human-AI collaboration metrics                  | `PARTIAL` | `agent.escalated`, `agent.handoff` events.        | No handoff context quality score, no post-escalation human handle time, no human override tracking.                   |
| ROI & cost tracking                             | `PARTIAL` | LLM cost events exist.                            | No ROI computation, no "with AI vs without AI" comparison, no cost savings dashboard.                                 |
| Customer cohort analysis                        | `MISSING` | —                                                 | No cohort segmentation engine.                                                                                        |
| A/B testing framework                           | `MISSING` | —                                                 | No experiment assignment, no statistical significance testing.                                                        |

**Tier 4 Summary:** Basic session lifecycle events exist but business metrics require: (a) outcome classification, (b) repeat-contact detection, (c) voice pipeline integration, (d) cohort/A/B infrastructure.

---

## Tier 5: Custom Event Emission & Business Metrics Platform

### 5.1 Three-Pattern Event Model

| Feature                                                         | Status    | What Exists                                                                                                                                                                       | Gap                                                                                 |
| --------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Pattern 1: Inline SDK emission** (`context.analytics.emit()`) | `MISSING` | —                                                                                                                                                                                 | No `ToolContext.analytics` API. No SDK-level emit function exposed to tool authors. |
| **Pattern 1: ABL DSL `emit` blocks**                            | `MISSING` | —                                                                                                                                                                                 | No `emit` keyword in ABL grammar. No compiler support. No IR representation.        |
| **Pattern 2: Synchronous guardrail events**                     | `MISSING` | —                                                                                                                                                                                 | No guardrail event emission framework.                                              |
| **Pattern 3: Async AI evaluation pipeline**                     | `MISSING` | —                                                                                                                                                                                 | No evaluation dispatcher, no event bus, no evaluator fan-out, no score writer.      |
| Unified event model                                             | `BUILT`   | `PlatformEvent` type with full envelope (event_id, event_type, category, tenant_id, project_id, session_id, agent_name, data, metadata, etc.). EventRegistry with Zod validation. | ✓ The model exists.                                                                 |
| Event schema governance                                         | `BUILT`   | EventRegistry with `register()`, `validate()`, `validateData()`, metadata, versioning.                                                                                            | ✓ Schema governance infrastructure exists.                                          |

### 5.2 Evaluation Pipeline

| Feature                          | Status    | What Exists | Gap                                               |
| -------------------------------- | --------- | ----------- | ------------------------------------------------- |
| Evaluation dispatcher            | `MISSING` | —           | No event bus consumer → evaluator fan-out system. |
| No-code scorecard evaluators     | `MISSING` | —           | No scorecard definition or UI.                    |
| Low-code NL criteria evaluators  | `MISSING` | —           | No NL-to-evaluator compiler.                      |
| Pro-code custom scorer functions | `MISSING` | —           | No scorer function runtime.                       |
| DSL declarative evaluations      | `MISSING` | —           | No `evaluations` block in ABL grammar.            |
| Configurable sampling strategies | `MISSING` | —           | No sampling config.                               |

**Tier 5 Summary:** The unified event model and schema governance are built. The three emission patterns and the entire evaluation pipeline are unbuilt.

---

## Tier 6: AI-Powered Insights & Feedback Loops

| Feature                             | Status    | What Exists | Gap                                                                      |
| ----------------------------------- | --------- | ----------- | ------------------------------------------------------------------------ |
| Anomaly detection & alerting        | `MISSING` | —           | No statistical anomaly detection, no threshold engine, no alert routing. |
| Real-time intervention triggers     | `MISSING` | —           | No escalation score formula, no struggling-user detection.               |
| AI root cause analysis              | `MISSING` | —           | No embedding clustering, no trace decomposition, no LLM diagnosis.       |
| AI optimization suggestions         | `MISSING` | —           | No gap analysis (content/data/action), no AST-targeted suggestions.      |
| Automated prompt/instruction tuning | `MISSING` | —           | No DSPy integration, no eval→improve loop.                               |
| Structured improvement workflow     | `MISSING` | —           | No capture→evaluate→identify→experiment→deploy→monitor pipeline.         |
| Conversation outcome prediction     | `MISSING` | —           | No ML models for mid-conversation prediction.                            |
| AI-inferred CSAT                    | `MISSING` | —           | No CSAT prediction model.                                                |
| Churn risk scoring                  | `MISSING` | —           | No churn signal detection.                                               |
| Risk score monitoring               | `MISSING` | —           | No unified risk dashboard.                                               |

**Tier 6 Summary:** Entirely unbuilt. This is the most advanced tier and depends on Tiers 1-5 being largely complete.

---

## Tier 7: Analytics Data Platform & APIs

| Feature                                    | Status    | What Exists                                                            | Gap                                                                                  |
| ------------------------------------------ | --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Pre-built dashboards (7 types)             | `MISSING` | —                                                                      | No dashboard framework.                                                              |
| Custom dashboard builder                   | `MISSING` | —                                                                      | No drag-and-drop widget system.                                                      |
| Drill-down (metric → conversation → trace) | `MISSING` | —                                                                      | No drill-down navigation.                                                            |
| Analytics REST APIs                        | `PARTIAL` | `EventQueryService` with `query()`, `aggregate()`, `count()`.          | No HTTP routes exposed. No `/api/analytics/*` endpoints.                             |
| Data export (S3, BI, streaming)            | `PARTIAL` | Webhook forwarding to external systems.                                | No S3 export, no BI connectors, no scheduled exports.                                |
| Report templates                           | `MISSING` | —                                                                      | —                                                                                    |
| Conversational analytics (NL-to-SQL)       | `MISSING` | —                                                                      | No semantic layer, no text-to-SQL, no agentic decomposition. Largest single feature. |
| Conversation search (keyword + semantic)   | `MISSING` | —                                                                      | No full-text index on messages, no embedding search.                                 |
| Conversation audit trails                  | `PARTIAL` | Existing AuditStore in runtime. Event cascade hooks for data deletion. | No tamper-evident hash chains, no comprehensive audit event coverage.                |
| Regional analytics                         | `MISSING` | —                                                                      | No multi-region ClickHouse, no data residency routing.                               |

**Tier 7 Summary:** The query service layer exists but nothing is exposed as APIs or UI. The NL-to-SQL conversational interface is the marquee feature and is entirely unbuilt.

---

## Infrastructure & Cross-Cutting Gaps

| Area                            | Status    | What Exists                                                                        | Gap                                                 |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| Event storage (ClickHouse)      | `BUILT`   | ClickHouseEventStore with batched writes, tenant-scoped queries, TTL.              | ✓                                                   |
| Event storage (Memory fallback) | `BUILT`   | MemoryEventStore for dev/test.                                                     | ✓                                                   |
| Event queues                    | `BUILT`   | DirectQueue, BullMQEventQueue, KafkaEventQueue, MemoryEventQueue.                  | ✓                                                   |
| Event emission & validation     | `BUILT`   | EventEmitter + EventRegistry with Zod schemas. 40+ event types.                    | ✓                                                   |
| Resilience (3-level failover)   | `BUILT`   | ResilientEventEmitter, FileSystemWAL, EventRecoveryService.                        | ✓                                                   |
| Retention policies              | `BUILT`   | Plan-based TTL (FREE/TEAM/BUSINESS/ENTERPRISE) with compliance overrides.          | ✓                                                   |
| GDPR compliance                 | `BUILT`   | Session delete, actor anonymization, tenant offboarding. Cascade hooks integrated. | ✓                                                   |
| Webhook forwarding              | `BUILT`   | Pattern-based subscription matching, HMAC signing, retry logic.                    | ✓                                                   |
| Query service + caching         | `BUILT`   | EventQueryService with tenant-scoped cache keys.                                   | ✓                                                   |
| Trace dual-write bridge         | `BUILT`   | Fire-and-forget trace → platform event mapping.                                    | ✓                                                   |
| Materialized views              | `PARTIAL` | DDL defined for `session_metrics_daily_mv` and `llm_cost_hourly_mv`.               | Not deployed. More MVs needed for dashboards.       |
| OTel integration                | `MISSING` | —                                                                                  | No OTel SDK, no collector, no span exporter.        |
| Evaluation pipeline             | `MISSING` | —                                                                                  | Core missing piece that blocks Tiers 2, 3, 5, 6.    |
| Alert engine                    | `MISSING` | —                                                                                  | No threshold/anomaly alerting system.               |
| Dashboard framework             | `MISSING` | —                                                                                  | No UI infrastructure for analytics.                 |
| Semantic layer                  | `MISSING` | —                                                                                  | No business vocabulary → SQL mapping.               |
| ML model serving                | `MISSING` | —                                                                                  | No infrastructure for sentiment, prediction models. |

---

## Implementation Plan: Phased Approach to Full Vision

### Phase 1: Foundation Metrics & APIs (Builds on current eventstore)

**Goal:** Expose existing event data through APIs and basic aggregation. Get metrics flowing to a consumable endpoint.

**Work items:**

1. **Analytics API routes** — Create `/api/analytics/*` REST endpoints in runtime that expose `EventQueryService` methods with tenant-scoped auth:
   - `GET /api/analytics/metrics` — Aggregated metrics (containment, error rate, latency, cost)
   - `GET /api/analytics/events` — Event listing with filters
   - `GET /api/analytics/agents/:name/performance` — Per-agent rollup
   - `POST /api/analytics/query` — Ad-hoc query interface

2. **Materialized views deployment** — Deploy existing `session_metrics_daily_mv` and `llm_cost_hourly_mv`. Add new MVs:
   - `agent_performance_hourly_mv` (invocations, errors, cost, duration by agent)
   - `tool_usage_daily_mv` (calls, success rate, avg latency by tool)
   - `error_summary_hourly_mv` (error counts by type, agent, provider)

3. **ClickHouse DDL in database init** — Add platform_events table + MVs to the standard ClickHouse initialization flow.

4. **Session outcome enrichment** — Extend `session.ended` event data with:
   - `outcome_category` (10-category classification from Tier 4)
   - `total_cost` (sum of LLM costs in session)
   - `containment` boolean flag

5. **Basic operational dashboard** (Studio) — A single overview page with:
   - Active sessions (from Redis)
   - Error rate (from MV)
   - Avg latency P95 (from MV)
   - Escalation rate (from MV)
   - Token spend (from MV)
   - Top agents table

6. **Threshold-based alerting** — Simple alert engine:
   - Define alert rules in MongoDB (metric, threshold, window, severity, notification channel)
   - Scheduler checks MVs against thresholds every minute
   - Notifications via webhook (Slack/PagerDuty integration)

**Dependencies:** Current eventstore (done) → APIs → MVs → Dashboard

---

### Phase 2: Evaluation Pipeline & Quality Scoring

**Goal:** Build the async evaluation dispatcher — the single most important missing piece. This unlocks Tiers 2, 3, 5, and 6.

**Work items:**

1. **Evaluation dispatcher** — New package `@abl/evaluator` or module in eventstore:
   - Event bus consumer (Redis Streams or BullMQ) subscribes to `session.ended` events
   - Fan-out to configured evaluators per tenant/project
   - Sampling strategies (100%, stratified, anomaly-triggered)
   - Score writer emits evaluation results as platform events

2. **LLM-as-judge framework** — Generic evaluator that:
   - Takes conversation transcript + agent trace
   - Runs configurable evaluation criteria against an LLM
   - Returns structured scores (1-5 scales, pass/fail, categorical)
   - Supports rubric definitions (helpfulness, accuracy, safety, etc.)

3. **Built-in evaluator suite** — Pre-built evaluators for:
   - **Quality score** (composite: resolution, accuracy, helpfulness, coherence, professionalism)
   - **Safety check** (PII handling, toxicity, policy compliance)
   - **Helpfulness score** (information gain, task progression, wasted turns)
   - **Goal completion** (did agent achieve its defined objective?)

4. **Conversation summarizer** — Async evaluator that generates:
   - Executive summary (1-2 sentences)
   - Key topics, actions taken, outcome, sentiment arc
   - Stored in ClickHouse for search and aggregation

5. **Evaluation result schemas** — New event types:
   - `evaluation.completed` (evaluator_id, scores, reasoning, confidence)
   - `evaluation.failed` (evaluator_id, error)

6. **Studio evaluation config UI** — Per-project evaluation settings:
   - Which evaluators to run
   - Sampling rates
   - Custom criteria (no-code: scorecard questions; low-code: NL prompts)

**Dependencies:** Phase 1 APIs → Evaluation dispatcher → Quality scoring → Dashboard integration

---

### Phase 3: Custom Events, Inline Emission & DSL Support

**Goal:** Enable customers to emit and analyze their own business events.

**Work items:**

1. **SDK inline emission** — Add `context.analytics.emit(eventName, properties)` to `ToolContext`:
   - Validates against registered schemas
   - Flows through existing EventEmitter → ClickHouse
   - Available in tool implementations

2. **ABL DSL `emit` keyword** — Compiler changes:
   - Add `emit "EventName" { ... }` syntax to ABL grammar
   - Compile to IR `EmitEventInstruction`
   - Runtime executor emits event at the specified point
   - Events version-controlled with agent definition

3. **ABL DSL `evaluations` block** — Compiler changes:
   - Add `evaluations { ... }` to project-level ABL
   - Support `when:`, `type:`, `prompt:`, `output:`, `sampling:` fields
   - Compile to IR evaluation criteria
   - Runtime registers criteria with evaluation dispatcher

4. **Outcome classification** — ML or rule-based classifier:
   - Classify every session into 10 outcome categories
   - Run as async evaluation after `session.ended`
   - Store result on session and as platform event

5. **Event catalog UI** — Studio page showing:
   - All registered event types (platform + custom)
   - Schema definitions, sample data
   - Event volume trends

**Dependencies:** Phase 2 evaluation pipeline → DSL support → Custom events

---

### Phase 4: Sentiment, Struggle Detection & Conversation Analytics

**Goal:** Build the conversation intelligence layer.

**Work items:**

1. **Sentiment analysis** — Integrate sentiment model:
   - Per-turn sentiment scoring (positive/neutral/negative, -1 to +1)
   - Sentiment trajectory tracking (improving/stable/declining)
   - Run as lightweight evaluation on each message or as batch on session end
   - Store as platform events

2. **User struggle/friction detection** — Behavioral signals:
   - Rephrasing detection (cosine similarity > 0.85 across consecutive user turns)
   - Message length trend (monotonic increase over 3+ turns)
   - Explicit frustration language (keyword/regex)
   - Turn count outlier (Z-score > 2.5)
   - Composite friction score

3. **Conversation flow analysis** — Compute from flow events:
   - Path analysis (most common agent/step sequences)
   - Drop-off funnels (at which step do users abandon)
   - Loop detection (same step/topic revisited)
   - Turn efficiency (minimum possible turns / actual turns)

4. **Topic/intent distribution** — Derive from conversation data:
   - Auto-classify conversations by intent (LLM or lightweight model)
   - Volume distribution, trends, co-occurrence
   - Custom topic taxonomies (tenant-scoped)

5. **Conversation tagging engine** — Rule-based auto-tagging:
   - Keyword, pattern, LLM-classified, outcome-based, composite rules
   - Tags stored in MongoDB, tenant-scoped
   - Tag-based filtering in dashboards

6. **Hallucination detection** — Integrate faithfulness scoring:
   - RAGAS faithfulness or SelfCheckGPT approach
   - Run as async evaluation on conversations with RAG
   - Track hallucination rate per agent

**Dependencies:** Phase 2 evaluation pipeline → Sentiment/struggle → Flow analysis → Tagging

---

### Phase 5: OTel Integration & Observability

**Goal:** Make tracing OTel-native for interoperability with Datadog, Grafana, etc.

**Work items:**

1. **OTel SDK integration** — Instrument the runtime:
   - Add `@opentelemetry/api` + `@opentelemetry/sdk-trace-node`
   - Create ABL-specific span kinds mapping to OTel GenAI conventions
   - W3C traceparent propagation across agent handoffs
   - Span attributes per OTel GenAI semantic conventions

2. **OTel collector export** — Configurable trace exporter:
   - OTLP/gRPC to external collectors (Datadog, Grafana, Jaeger)
   - Dual-export: OTel collector + existing TraceStore + EventStore

3. **Span hierarchy restructuring** — Proper parent-child spans:
   - Session span → Agent span → LLM/Tool/Retriever spans
   - Replace flat `spanId`/`parentSpanId` with structured span tree
   - Add missing span kinds: RETRIEVER, EMBEDDING, RERANKER, GUARDRAIL, EVALUATOR

4. **TTFT tracking** — Streaming-aware instrumentation:
   - Instrument LLM provider to record time-to-first-token
   - Emit as span attribute + platform event

**Dependencies:** Can be done in parallel with Phases 3-4. Independent of evaluation pipeline.

---

### Phase 6: AI Intelligence & Intervention

**Goal:** Add anomaly detection, intervention triggers, root cause analysis, and optimization suggestions.

**Work items:**

1. **ML anomaly detection** — Statistical + ML-based:
   - Z-score and IQR methods for initial threshold-based detection
   - Per-segment baselines (per intent, per agent, per customer tier)
   - Seasonal pattern recognition
   - Integration with alert engine from Phase 1

2. **Real-time intervention triggers** — Escalation score computation:
   - Composite score from sentiment, confidence, loop detection, SLA risk
   - Configurable thresholds per tenant/project
   - Real-time evaluation during active sessions
   - Action: offer human handoff, auto-escalate, supervisor alert

3. **AI root cause analysis** — LLM-powered diagnosis:
   - When anomaly detected: collect related traces, conversations, metrics
   - Feed to LLM for natural-language root cause hypothesis
   - Trace decomposition: identify which component contributes most to failures

4. **AI optimization suggestions** — Intercom-style gap analysis:
   - Analyze failed/low-quality conversations
   - Identify content gaps, data gaps, action gaps
   - Target specific ABL DSL nodes (tools, extraction fields, routing rules)
   - Weekly prioritized recommendations

5. **Benchmark calibration** — Baseline establishment:
   - Cold-start defaults → baseline formation → threshold calibration → steady state
   - Per-metric, per-intent, per-agent baselines
   - Alert fatigue prevention (cooldowns, composite alerts, severity tiers)

6. **Predictive analytics** — ML models:
   - Conversation outcome prediction (mid-conversation)
   - AI-inferred CSAT (cover 100% vs 5-15% survey response)
   - Churn risk scoring from conversation signals

**Dependencies:** Phases 2-4 (needs evaluation scores + sentiment + metrics to detect anomalies)

---

### Phase 7: Analytics Platform & NL Interface

**Goal:** Build the conversational analytics interface and full platform.

**Work items:**

1. **Semantic layer** — Business vocabulary → SQL mapping:
   - YAML definitions for metrics (containment_rate, quality_score, cost, etc.)
   - Dimension definitions (agent_name, intent, channel, etc.)
   - Temporal rules ("last week" → SQL)
   - Tenant-scoped metric extensions (custom events → custom metrics)

2. **Text-to-SQL engine** — NL query → ClickHouse SQL:
   - LLM with semantic layer context generates ClickHouse SQL
   - Mandatory tenant_id injection at execution layer
   - Query validation and complexity limits
   - Follow-up questions with context retention

3. **Agentic query decomposition** — For complex questions:
   - Planner → Executor → Validator agent pipeline
   - Multi-step queries that combine aggregation, trend analysis, drill-down
   - Natural language summaries alongside data

4. **Visualization auto-generation** — Chart selection:
   - Time series → line chart
   - Comparison → bar chart
   - Distribution → histogram
   - Composition → pie/donut
   - Flow → Sankey diagram

5. **Conversation search** — Full-text + semantic:
   - ClickHouse full-text index on message content
   - Embedding-based semantic search on conversation summaries
   - Combined structured + semantic query decomposition

6. **Custom dashboard builder** — Studio UI:
   - Drag-and-drop widget placement
   - Chart library (line, bar, pie, funnel, Sankey, heatmap)
   - Metric/dimension selectors
   - Filter configuration
   - Scheduling and export

7. **Analytics data export** — Multi-format:
   - Scheduled CSV/Parquet to S3/GCS
   - BI tool connectors (Tableau, Power BI, Looker via JDBC/REST)
   - Streaming via webhooks/Kafka (already partially done)

8. **Audit trails** — Tamper-evident:
   - Append-only ClickHouse `audit_trail` table
   - Hash chains for tamper detection
   - Comprehensive event coverage (data access, config changes, exports)

9. **Regional analytics** — Multi-region support:
   - Regional ClickHouse instances
   - Data residency routing
   - Cross-region materialized views for global aggregation

**Dependencies:** Phases 1-6 (needs all data and evaluation infrastructure in place)

---

## Priority Ranking

| Priority | Item                                               | Rationale                                                                        |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| **P0**   | Analytics REST APIs (Phase 1.1)                    | Unblocks all consumption of existing data                                        |
| **P0**   | Materialized views (Phase 1.2)                     | Pre-aggregation needed for dashboard performance                                 |
| **P0**   | Evaluation dispatcher (Phase 2.1)                  | Single most critical missing piece — blocks quality scoring, sentiment, insights |
| **P0**   | LLM-as-judge framework (Phase 2.2)                 | Core of quality evaluation                                                       |
| **P0**   | Basic operational dashboard (Phase 1.5)            | First visible value to users                                                     |
| **P1**   | SDK inline emission (Phase 3.1)                    | Customer-defined events — key differentiator                                     |
| **P1**   | ABL DSL `emit` keyword (Phase 3.2)                 | Unique differentiator vs. competitors                                            |
| **P1**   | Sentiment analysis (Phase 4.1)                     | Required for struggle detection and intervention                                 |
| **P1**   | Conversation summarizer (Phase 2.4)                | Powers search, audit, review                                                     |
| **P1**   | Threshold alerting (Phase 1.6)                     | Operational necessity                                                            |
| **P1**   | OTel integration (Phase 5)                         | Interoperability with existing monitoring stacks                                 |
| **P2**   | NL-to-SQL conversational interface (Phase 7.1-7.3) | Market differentiator, high effort                                               |
| **P2**   | AI optimization suggestions (Phase 6.4)            | High impact but depends on evaluation data                                       |
| **P2**   | Custom dashboard builder (Phase 7.6)               | Enterprise requirement                                                           |
| **P2**   | Anomaly detection (Phase 6.1)                      | Depends on baseline data                                                         |
| **P3**   | Predictive analytics (Phase 6.6)                   | Requires significant historical data                                             |
| **P3**   | Regional analytics (Phase 7.9)                     | Enterprise-scale requirement                                                     |
| **P3**   | Cross-tenant benchmarking                          | Requires large customer base                                                     |

---

## What's Built vs. What's Needed: Summary Table

| Category                | Built                                 | Total Needed                                                         | %    |
| ----------------------- | ------------------------------------- | -------------------------------------------------------------------- | ---- |
| Event schemas           | 40+ event types                       | ~60 (adding voice, evaluation, guardrail, search, prediction events) | ~67% |
| Storage & queues        | 2 backends, 4 queues, resilience, WAL | Same + more MVs + full-text indexes                                  | ~85% |
| Data lifecycle          | Retention, GDPR, cascade hooks        | Same + audit trail hash chains                                       | ~90% |
| APIs                    | Query service (internal)              | REST endpoints, GraphQL, BI connectors                               | ~15% |
| Dashboards              | None                                  | 7 pre-built + custom builder                                         | 0%   |
| Evaluation pipeline     | None                                  | Dispatcher, LLM-judge, scorers, sampling                             | 0%   |
| Sentiment/NLP           | None                                  | Sentiment, frustration, hallucination, summarization                 | 0%   |
| OTel integration        | None                                  | SDK, collector export, span hierarchy                                | 0%   |
| AI intelligence         | None                                  | Anomaly detection, RCA, optimization, prediction                     | 0%   |
| NL analytics            | None                                  | Semantic layer, text-to-SQL, agentic decomposition                   | 0%   |
| Custom events (SDK/DSL) | None                                  | SDK emit API, DSL emit blocks, DSL evaluations                       | 0%   |

**Bottom line:** The data infrastructure (storage, queues, schemas, resilience, compliance) is 80-90% complete. The analytics application layer (everything that produces insight from data) is ~5% complete. The next highest-impact work is: (1) expose APIs, (2) build the evaluation pipeline, (3) build the first dashboard.
