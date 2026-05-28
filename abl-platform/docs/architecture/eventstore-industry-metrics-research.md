# EventStore Industry Metrics Research

> **Date:** 2026-02-27
> **Scope:** Comprehensive analysis of analytics events and metrics tracked by 15+ leading AI/agent platforms
> **Purpose:** Identify industry best practices, benchmark our eventstore coverage, and document gaps

---

## Platforms Researched

| Platform             | Focus                                | Notable Features                                                              |
| -------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| **LangSmith**        | LangChain observability              | Run types (Chain, LLM, Tool, Retriever, Agent), feedback, dataset experiments |
| **Arize Phoenix**    | OpenInference traces                 | LLM/Embedding/Retrieval spans, span scoring, replay                           |
| **Helicone**         | LLM analytics (21+ metrics)          | Session paths, custom properties, user cost analytics, caching                |
| **Braintrust**       | Span tracing, experiments            | Human feedback, dataset building from traces, scoring functions               |
| **Voiceflow**        | Conversational AI                    | Session analytics, engagement metrics, NLU tracking                           |
| **LlamaIndex**       | RAG observability                    | Retrieval spans, embedding operations, integration with Phoenix               |
| **Weights & Biases** | Traces for LLMs                      | Prompt versioning, experiment tracking, model registry                        |
| **OpenLLMetry**      | OpenTelemetry for LLMs               | Semantic conventions, provider-agnostic attributes, standard metrics          |
| **AgentOps**         | Multi-agent tracking                 | Session states, time-travel debugging, multi-agent interaction, host env      |
| **CrewAI**           | Multi-agent systems                  | Crew execution, agent hierarchy, task tracking                                |
| **Langfuse**         | Open-source LLM observability        | Observation types, session grouping, environment tagging, cost tracking       |
| **Traceloop**        | Quality evaluations                  | Standard metrics (faithfulness, relevance, safety), custom evaluators         |
| **Lunary**           | User analytics, PII                  | Topic classification, language detection, PII masking, satisfaction           |
| **HoneyHive**        | Distributed tracing (25+ evaluators) | Prompts, retrieval, MCP/A2A, agents, regression detection                     |
| **Portkey**          | Budget limits, metadata              | 21+ metrics, budget tracking, feedback weights, OpenTelemetry compliance      |
| **MLflow**           | 50+ metrics, prompt versioning       | Auto-logging, model registry, full lineage tracking                           |

---

## Metric Categories

### 1. Session & Conversation Lifecycle

**What the industry tracks:**

| Metric                | Tracked By        | Description                                   |
| --------------------- | ----------------- | --------------------------------------------- |
| Session Start         | All platforms     | Creation timestamp, initiating user/channel   |
| Session End           | All platforms     | Termination timestamp and end state           |
| Session State         | AgentOps          | Success, Failure, Indeterminate               |
| Session Duration      | All platforms     | Total elapsed time                            |
| Session Path          | Helicone          | Hierarchical trace of parent-child requests   |
| Session Resume        | Langfuse, custom  | Continuation of existing sessions             |
| Turn Count            | Voiceflow, Lunary | Number of exchanges in conversation           |
| Messages Per Session  | Helicone, Lunary  | Average or total message count                |
| Conversation Topics   | Lunary            | Classification of conversation subject matter |
| Conversation Language | Lunary            | Detected language of user interactions        |

**Our coverage:** `session.started`, `session.ended`, `session.resumed`, `session.terminated` -- **Good**. Missing: topic classification, language detection (deferred).

---

### 2. LLM Call Metrics

**What the industry tracks:**

#### Request Metadata

| Metric             | Tracked By        | Description                                      |
| ------------------ | ----------------- | ------------------------------------------------ |
| Model Name/ID      | All               | Requested model (e.g., "gpt-4", "claude-3-opus") |
| Actual Model Used  | Helicone, Portkey | May differ from requested model                  |
| Provider Name      | All               | LLM provider (openai, anthropic, aws.bedrock)    |
| Operation Type     | OpenLLMetry       | chat, text_completion, embeddings                |
| System Fingerprint | OpenAI            | Version/config identifier                        |

#### Model Parameters

| Metric                     | Tracked By          | Description                   |
| -------------------------- | ------------------- | ----------------------------- |
| Temperature                | LangSmith, Langfuse | Sampling temperature          |
| Max Tokens                 | All                 | Maximum tokens requested      |
| Top P / Top K              | LangSmith, Portkey  | Nucleus/top-k sampling        |
| Frequency/Presence Penalty | OpenLLMetry         | Token frequency penalties     |
| Stop Sequences             | Helicone            | Custom stop sequences         |
| Seed                       | Braintrust          | For reproducibility           |
| Reasoning Mode             | OpenLLMetry         | Extended thinking (o1 models) |

#### Token Usage

| Metric                    | Tracked By             | Description                    |
| ------------------------- | ---------------------- | ------------------------------ |
| Input Tokens              | All                    | Prompt tokens consumed         |
| Output Tokens             | All                    | Completion tokens generated    |
| Total Tokens              | All                    | Sum of input + output          |
| **Cache Creation Tokens** | Anthropic, Helicone    | Tokens written to prompt cache |
| **Cache Read Tokens**     | Anthropic, Helicone    | Tokens served from cache       |
| Tokens Per Second         | Helicone, Portkey      | Throughput rate                |
| **Reasoning Tokens**      | OpenAI o1, OpenLLMetry | Chain-of-thought tokens        |

#### Latency & Timing

| Metric                         | Tracked By                     | Description                        |
| ------------------------------ | ------------------------------ | ---------------------------------- |
| Total Duration                 | All                            | End-to-end request duration        |
| **Time to First Token (TTFT)** | Helicone, Portkey, OpenLLMetry | Latency until first token streamed |
| Time Per Output Token          | Helicone                       | Average decode time per token      |
| Queue Time                     | Portkey                        | Time waiting before processing     |
| Duration Distribution          | Helicone                       | Histogram of latencies             |

#### Cost & Billing

| Metric                | Tracked By          | Description               |
| --------------------- | ------------------- | ------------------------- |
| Total Cost            | All                 | USD cost of the request   |
| Input/Output Cost     | Helicone, Portkey   | Breakdown by token type   |
| Cache Cost Savings    | Helicone, Anthropic | Cost saved via caching    |
| Cost Per User         | Helicone            | Unit economics            |
| Cost Per Conversation | Langfuse            | Aggregate cost by session |
| Budget Tracking       | Portkey             | Spend against limits      |

#### Response Metadata

| Metric            | Tracked By          | Description                                                              |
| ----------------- | ------------------- | ------------------------------------------------------------------------ |
| **Finish Reason** | All                 | Why generation stopped: `stop`, `length`, `tool_calls`, `content_filter` |
| Stop Sequence     | Helicone            | Actual sequence that triggered stop                                      |
| Is Streaming      | LangSmith, Langfuse | Whether response was streamed                                            |

**Our coverage:** `llm.call.completed` has model, provider, input/output/total tokens, estimated_cost, latency_ms, streaming_used. **Gaps:** Missing TTFT, cache tokens, finish reason (adding as optional fields).

---

### 3. Tool & Function Call Tracking

**What the industry tracks:**

| Metric                  | Tracked By                   | Description                    |
| ----------------------- | ---------------------------- | ------------------------------ |
| Tool Name               | All                          | Identifier of the tool         |
| Tool Type               | OpenLLMetry                  | function, extension, datastore |
| Tool Call ID            | LangSmith                    | Unique invocation identifier   |
| Tool Arguments          | LangSmith, Langfuse (opt-in) | Parameters passed              |
| Tool Result             | LangSmith, Langfuse (opt-in) | Output returned                |
| Tool Duration           | All                          | Execution time                 |
| Tool Success/Failure    | All                          | Binary outcome                 |
| Tool Error Type/Message | All                          | Classification and details     |
| Tool Binding Type       | Platform-specific            | HTTP, Lambda, Sandbox, MCP     |
| Tool Retry Count        | AgentOps                     | Number of retry attempts       |

**Our coverage:** `tool.call.completed`, `tool.call.failed`, `tool.call.retried`, `tool.error.handled` -- **Good**. We track name, type, success, latency, error details, retry info, and handler action.

---

### 4. Agent Routing & Orchestration

**What the industry tracks:**

| Metric                      | Tracked By              | Description                       |
| --------------------------- | ----------------------- | --------------------------------- |
| Agent Enter/Exit            | AgentOps, LangSmith     | Agent lifecycle events            |
| Agent Name/Type/Mode        | All                     | Identification and configuration  |
| Agent Reasoning Steps       | Phoenix (OpenInference) | Thought process traces            |
| Multi-Agent Interactions    | AgentOps, CrewAI        | Communication between agents      |
| Agent Handoffs              | AgentOps, HoneyHive     | Routing with source/target/reason |
| Delegate Start/Complete     | AgentOps                | Sub-agent delegation              |
| Routing Decision            | HoneyHive               | Which agent/handler selected      |
| Intent Detection/Confidence | Voiceflow, Lunary       | Classified user intent with score |
| Task Start/Complete/Status  | CrewAI                  | Discrete task tracking            |
| Flow Step Enter/Exit        | Platform-specific       | Scripted flow execution           |
| Flow Transition             | Platform-specific       | State machine transitions         |

**Our coverage:** `agent.entered`, `agent.exited`, `agent.handoff`, `agent.escalated`, `agent.delegated`, `agent.fanout.completed`, `agent.decision`, `agent.constraint.checked`, plus `flow.step.entered/exited`, `flow.transition` -- **Excellent**. We have the most comprehensive agent routing coverage of any platform.

---

### 5. User Message & Bot Response Tracking

**What the industry tracks:**

| Metric                | Tracked By          | Description                    |
| --------------------- | ------------------- | ------------------------------ |
| User Message Received | All                 | Incoming user input            |
| Bot Response Sent     | All                 | Outgoing assistant response    |
| Message ID            | LangSmith, Langfuse | Unique identifier              |
| Message Role          | All                 | user, assistant, system, tool  |
| Message Content       | All (opt-in)        | Text, multimodal content       |
| Message Length        | Helicone, Lunary    | Character/token count          |
| Message Language      | Lunary              | Detected language              |
| Channel               | Helicone, Lunary    | Source (web, mobile, api, sdk) |
| Has Attachments       | LangSmith           | File/image attachments         |
| Context Window Size   | Helicone            | Messages included in history   |

**Our coverage:** `channel.message.received`, `channel.message.sent` for external channels only. **Gap:** No events on the core WebSocket/debug path (adding `message.user.received`, `message.agent.sent`).

---

### 6. Error Tracking & Classification

**What the industry tracks:**

| Metric            | Tracked By        | Description                                                                          |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------ |
| Error Type        | All               | authentication, rate_limit, timeout, api, validation, tool_execution, content_filter |
| Error Code        | Lunary, HoneyHive | Specific error code                                                                  |
| Error Message     | All               | Human-readable description                                                           |
| Error Stack Trace | Lunary            | Debugging information                                                                |
| Error Severity    | HoneyHive         | critical, error, warning, info                                                       |
| Error Location    | HoneyHive         | Where error occurred (agent, step, tool)                                             |
| Recoverable       | HoneyHive         | Whether error is retryable                                                           |
| HTTP Status Code  | Helicone, Portkey | Response status codes                                                                |

**Our coverage:** `tool.call.failed` and `llm.call.failed` with error_type/error_message. `tool.error.handled` with handler_action. **Partial** -- per-category errors are sufficient; unified error event deferred.

---

### 7. Evaluation & Quality Metrics

**What the industry tracks:**

| Metric                   | Tracked By                       | Description                   |
| ------------------------ | -------------------------------- | ----------------------------- |
| Relevance                | LlamaIndex, Traceloop, HoneyHive | Response relevance to query   |
| Faithfulness             | LlamaIndex, Traceloop            | Grounded in provided context  |
| Coherence                | MLflow, HoneyHive                | Logical flow and consistency  |
| Helpfulness              | MLflow, Braintrust               | How useful the response is    |
| Toxicity                 | Lunary, LlamaIndex               | Harmful content measurement   |
| Safety                   | Traceloop, MLflow                | Content safety check          |
| Groundedness             | Phoenix, Traceloop               | Factual accuracy              |
| Answer Correctness       | Braintrust, MLflow               | Compared to ground truth      |
| LLM-as-Judge             | LangSmith, HoneyHive             | Model evaluates model output  |
| Custom Evaluators        | All                              | User-defined evaluation logic |
| 25+ Pre-built Evaluators | HoneyHive                        | Comprehensive built-in suite  |
| 50+ Built-in Metrics     | MLflow                           | Most extensive metric library |

**Our coverage:** `evaluation.started`, `evaluation.completed`, `evaluation.failed`, `evaluation.batch.completed`, `evaluation.threshold.violated`, `evaluation.quality.scored` (resolution, accuracy, helpfulness, coherence, professionalism, safety, PII handling), `evaluation.sentiment.analyzed`, `evaluation.summary.generated` -- **Excellent**. Our evaluation system is among the most comprehensive.

---

### 8. Feedback & Rating Events

**What the industry tracks:**

| Metric                   | Tracked By                      | Description                 |
| ------------------------ | ------------------------------- | --------------------------- |
| Thumbs Up/Down           | LangSmith, Langfuse, Braintrust | Binary user rating          |
| Star Rating              | Lunary                          | Numeric rating (1-5)        |
| User Satisfaction (CSAT) | Voiceflow, Lunary               | Satisfaction score          |
| Feedback Text            | LangSmith, Langfuse             | Free-form comments          |
| Human Annotation         | HoneyHive, LangSmith            | Manual label/tag            |
| Review Queue             | HoneyHive                       | Items pending review        |
| Ground Truth Label       | Braintrust, MLflow              | Correct answer for training |
| Feedback Weight          | Portkey                         | Importance multiplier       |

**Our coverage:** No user feedback events. **Gap:** Adding `feedback.submitted` schema (emission deferred until UI exists).

---

### 9. RAG / Retrieval Metrics

**What the industry tracks:**

| Metric               | Tracked By          | Description                 |
| -------------------- | ------------------- | --------------------------- |
| Retrieval Span       | Phoenix, LlamaIndex | RAG retrieval trace         |
| Query Text           | Phoenix (opt-in)    | Search query used           |
| Retrieved Documents  | Phoenix, LlamaIndex | Results with IDs and scores |
| Similarity Scores    | All RAG platforms   | Relevance scores            |
| Retrieval Latency    | All RAG platforms   | Time to retrieve            |
| Embedding Model      | Phoenix, LlamaIndex | Model used for embeddings   |
| Embedding Dimensions | OpenLLMetry         | Vector size                 |
| Vector DB Operations | LlamaIndex          | Query, insert, update       |

**Our coverage:** None. **Deferred** -- add when RAG features are built.

---

### 10. Guardrail & Safety Events

**What the industry tracks:**

| Metric                   | Tracked By         | Description                       |
| ------------------------ | ------------------ | --------------------------------- |
| Content Filter Triggered | Lunary, HoneyHive  | Safety check activated            |
| Content Filter Type      | Lunary             | hate, violence, sexual, self-harm |
| Toxicity Score           | Lunary, LlamaIndex | Harmful content measurement       |
| PII Detection            | Lunary             | Personal information found        |
| PII Masking Applied      | Lunary             | Redaction performed               |
| Constraint Check         | HoneyHive          | Validation rule evaluated         |
| Guardrail Type           | HoneyHive          | input, output, retrieval          |
| Guardrail Action         | HoneyHive          | block, warn, log, redact          |

**Our coverage:** `agent.constraint.checked` (pass/fail, violation_type, handler_action). **Partial** -- sufficient for now; PII detection events deferred.

---

### 11. Conversation Quality Metrics

**What the industry tracks:**

| Metric                   | Tracked By          | Description                 |
| ------------------------ | ------------------- | --------------------------- |
| Resolution Rate          | Voiceflow, Lunary   | % conversations resolved    |
| First Contact Resolution | Voiceflow           | Resolved without escalation |
| Completion Rate          | Voiceflow           | % flows completed           |
| Goal Achievement         | HoneyHive           | User objective met          |
| Escalation Rate          | Voiceflow, AgentOps | % conversations escalated   |
| Session Abandonment      | Voiceflow           | User left mid-conversation  |
| Bounce Rate              | Voiceflow           | Single-turn sessions        |
| Repeat User Rate         | Lunary              | Returning users             |

**Our coverage:** We track escalation events individually (`agent.escalated`), session completion (`session.ended`), and quality scores (`evaluation.quality.scored`). These can be aggregated for rates. **Good** -- can compute these from existing events.

---

### 12. Performance & Infrastructure

**What the industry tracks:**

| Metric              | Tracked By        | Description            |
| ------------------- | ----------------- | ---------------------- |
| Queue Wait Time     | Portkey           | Time before processing |
| Cache Hit/Miss Rate | Helicone, Portkey | Cache effectiveness    |
| Rate Limit Status   | Portkey           | Usage vs limit         |
| Concurrent Requests | Helicone          | Active request count   |
| Token Budget Used   | Portkey           | % of limit consumed    |
| Host Environment    | AgentOps          | System information     |

**Our coverage:** Infrastructure metrics are handled at the ClickHouse/Grafana level, not as platform events. **Appropriate** -- these are operational metrics, not analytics events.

---

### 13. Experiment & A/B Testing

**What the industry tracks:**

| Metric                   | Tracked By                    | Description                   |
| ------------------------ | ----------------------------- | ----------------------------- |
| Experiment ID/Name       | LangSmith, Braintrust, MLflow | Test identification           |
| Variant Assignment       | Braintrust                    | Which users got which version |
| Prompt Version           | Lunary, MLflow                | Prompt iteration tracking     |
| A/B Test Results         | Braintrust                    | Performance comparison        |
| Statistical Significance | Braintrust                    | Confidence in results         |

**Our coverage:** None. **Deferred** -- add when experiment framework is built. We have deployment versioning which partially covers prompt versioning.

---

### 14. Compliance & Security

**What the industry tracks:**

| Metric                | Tracked By                | Description             |
| --------------------- | ------------------------- | ----------------------- |
| Authentication Events | Lunary, platform-specific | Login/token validation  |
| Authorization Checks  | Platform-specific         | Permission verification |
| Data Retention        | Lunary                    | TTL enforcement         |
| Data Deletion (GDPR)  | Lunary                    | Erasure operations      |
| Data Export           | Lunary                    | User data extraction    |

**Our coverage:** `auth.login`, `auth.token.created`, plus GDPR services (`deleteBySessionIds`, `deleteTenant`, `anonymizeActor`, `scrubPII`), retention services. **Good**.

---

## Gap Analysis Summary

### Coverage Scorecard

| Category              | Coverage                                   | Score |
| --------------------- | ------------------------------------------ | ----- |
| Session Lifecycle     | 4 events, missing session.updated          | 85%   |
| LLM Calls             | 3 events, missing TTFT/cache/finish_reason | 75%   |
| Tool Calls            | 4 events, comprehensive                    | 95%   |
| Agent Routing         | 8 events, most comprehensive in industry   | 98%   |
| Gather/Extraction     | 4 events, unique to our platform           | 95%   |
| Flow Execution        | 3 events, good                             | 90%   |
| Channel Messaging     | 3 events, good                             | 90%   |
| Message Events (core) | 0 events -- major gap                      | 0%    |
| Deployment            | 3 events                                   | 85%   |
| Auth/Audit            | 2 events                                   | 70%   |
| Evaluation            | 8 events -- industry-leading               | 95%   |
| Feedback              | 0 events                                   | 0%    |
| RAG/Retrieval         | 0 events (no feature)                      | N/A   |
| Experiments           | 0 events (no feature)                      | N/A   |
| Guardrails            | 1 event (constraint.checked)               | 60%   |

### What to Implement Now (HIGH/MEDIUM priority)

| Priority   | Event                                                           | Gap                        |
| ---------- | --------------------------------------------------------------- | -------------------------- |
| **HIGH**   | `session.started` emission                                      | Schema exists, not wired   |
| **HIGH**   | `message.user.received`                                         | Every platform tracks this |
| **HIGH**   | `message.agent.sent`                                            | Every platform tracks this |
| **MEDIUM** | `session.updated`                                               | Context mutation tracking  |
| **MEDIUM** | LLM `time_to_first_token_ms`, `cache_*_tokens`, `finish_reason` | Industry standard          |
| **MEDIUM** | `feedback.submitted`                                            | Schema only (no UI yet)    |

### What to Defer (LOW priority / no feature yet)

| Priority | Gap                            | Reason                         |
| -------- | ------------------------------ | ------------------------------ |
| LOW      | Unified `error.occurred` event | Per-category errors sufficient |
| LOW      | PII detection/masking events   | PII pipeline immature          |
| LOW      | RAG/Retrieval events           | No RAG feature                 |
| LOW      | Experiment/A/B events          | No experiment framework        |
| LOW      | Topic/language classification  | Requires NLU pipeline          |

---

## Key Industry Insights

1. **Token tracking is universal** -- every platform tracks input/output/total tokens
2. **Cost is critical** -- USD cost tracking appears in nearly every platform
3. **TTFT is becoming standard** -- Time to First Token is tracked by Helicone, Portkey, OpenLLMetry
4. **Cache tokens matter** -- Anthropic prompt caching metrics are emerging as standard
5. **Evaluation is built-in** -- platforms are moving beyond logging to quality assessment
6. **Human feedback loop** -- thumbs up/down and annotations are standard in LangSmith, Langfuse, Braintrust
7. **Multi-agent is emerging** -- AgentOps, CrewAI, HoneyHive emphasize agent-to-agent tracking
8. **OpenTelemetry convergence** -- industry standardizing on OTEL semantic conventions
9. **Content is opt-in** -- prompts/completions treated as sensitive by default
10. **Session grouping is key** -- all platforms group requests into sessions/conversations

---

## Standards Referenced

- **OpenTelemetry GenAI Semantic Conventions** -- `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.client.token.usage`
- **OpenInference** -- LLM-specific span types: LLM, Retrieval, Embedding, Tool, Agent, Chain
- **Provider APIs** -- OpenAI usage format, Anthropic cache_creation/cache_read tokens
