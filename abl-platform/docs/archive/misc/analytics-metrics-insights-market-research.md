# ABL Platform: Analytics, Metrics & Insights

> Product specification for the ABL Platform analytics, metrics, and insights capabilities. Covers feature taxonomy, detailed tier specifications, implementation roadmap, and non-functional requirements for engineering handoff.

---

## Table of Contents

### Part I: Overview & Context

1. [Executive Summary](#1-executive-summary)
2. [Competitive Positioning](#2-competitive-positioning)
3. [Strategic Rationale](#3-strategic-rationale)
4. [Suggested Implementation Phases](#4-suggested-implementation-phases)

### Part II: Product Specification

5. [Feature Taxonomy](#5-feature-taxonomy)
6. [Tier 1: Operational Observability](#6-tier-1-operational-observability)
7. [Tier 2: Agent Performance Analytics](#7-tier-2-agent-performance-analytics)
8. [Tier 3: Conversation & Quality Analytics](#8-tier-3-conversation--quality-analytics)
   - 8.10 [Conversation Summarization](#810-conversation-summarization)
   - 8.11 [Conversation Tagging & Classification Rules](#811-conversation-tagging--classification-rules)
9. [Tier 4: Business Outcome Analytics](#9-tier-4-business-outcome-analytics)
10. [Tier 5: Custom Event Emission & Business Metrics Platform](#10-tier-5-custom-event-emission--business-metrics-platform)
11. [Tier 6: AI-Powered Insights & Feedback Loops](#11-tier-6-ai-powered-insights--feedback-loops)
    - 11.7 [Predictive Analytics & Risk Scoring](#117-predictive-analytics--risk-scoring)
12. [Tier 7: Analytics Data Platform & APIs](#12-tier-7-analytics-data-platform--apis)
    - 12.5 [Conversational Analytics Interface](#125-conversational-analytics-interface)
    - 12.6 [Conversation Search & Discovery](#126-conversation-search--discovery)
    - 12.7 [Conversation Audit Trails](#127-conversation-audit-trails)
    - 12.8 [Regional Analytics & Localization](#128-regional-analytics--localization)
13. [Competitive Landscape](#13-competitive-landscape)
14. [Benchmark Calibration & Metric Maturity](#14-benchmark-calibration--metric-maturity)
15. [Recommended Feature Roadmap](#15-recommended-feature-roadmap)

### Part III: Non-Functional Requirements

16. [Non-Functional Requirements](#16-non-functional-requirements)
17. [Sources](#17-sources)

---

# PART I: OVERVIEW & CONTEXT

---

## 1. Executive Summary

This specification proposes a comprehensive analytics, metrics, and insights capability for the ABL Platform, organized into seven tiers from foundational observability to advanced AI-powered intelligence.

### What We're Building

- **Operational Observability (Tier 1)** -- The foundation layer
  - End-to-end OTel-native tracing across sessions, agents, LLM calls, and tool executions
  - Latency tracking (P50/P95/P99), time to first token, and cost attribution by tenant/project/agent
  - Real-time operational dashboards with error rates, provider reliability, and drift detection

- **Agent Performance Analytics (Tier 2)** -- Understanding how agents perform
  - Quantitative metrics: invocations, steps, tool usage, cost per invocation, containment/escalation rates
  - Qualitative metrics via LLM-as-judge: goal completion, topic adherence, helpfulness, empathy, safety
  - Tool usage effectiveness: selection accuracy, parameter accuracy, retry rates, call efficiency
  - Reasoning quality, RAG/knowledge retrieval metrics, and multi-agent coordination tracking

- **Conversation & Quality Analytics (Tier 3)** -- Evaluating every conversation
  - 100% conversation quality evaluation (LLM-as-judge) with composite CX scoring
  - Helpfulness scoring, user struggle/friction detection, and sentiment progression analysis
  - Multi-turn memory/consistency tracking, topic discovery, and conversation flow analysis
  - Safety monitoring, hallucination detection, conversation summarization, and auto-tagging

- **Business Outcome Analytics (Tier 4)** -- Measuring business impact
  - Core CS metrics: containment, deflection, FCR, handle time, drop-off, customer effort
  - Voice channel metrics: WER, MOS, latency, barge-in, dead air, voice containment
  - Granular outcome classification (10 categories beyond resolved/escalated/abandoned)
  - Human-AI collaboration metrics, ROI tracking, cohort analysis, and A/B testing

- **Custom Event Emission & Business Metrics (Tier 5)** -- Customer-defined analytics
  - Three-pattern event model: inline emission (SDK + DSL), synchronous guardrails, async AI evaluation
  - ABL DSL declarative event emission -- events version-controlled with agent definitions
  - Unified event model with schema governance across all three patterns
  - Tiered evaluation criteria: no-code scorecards, low-code NL criteria, pro-code custom functions

- **AI-Powered Insights & Feedback Loops (Tier 6)** -- Automated intelligence
  - Anomaly detection and alerting with configurable thresholds
  - Real-time intervention triggers for struggling users (sentiment, confidence, loop detection)
  - AI root cause analysis and optimization suggestions targeting specific agent definitions
  - Predictive analytics: outcome prediction, AI-inferred CSAT, churn risk scoring
  - Structured improvement workflow: capture → evaluate → identify → experiment → deploy → monitor

- **Analytics Data Platform & APIs (Tier 7)** -- Access and exploration
  - Pre-built and custom dashboards with drill-down from metric → conversation → trace spans
  - Conversational analytics interface: natural language queries over agent data (NL-to-SQL)
  - Conversation search (keyword + semantic), audit trails, and data export (S3, BI tools, streaming)
  - Analytics REST APIs, report templates, and regional analytics with data residency support

### Key Differentiators

- **DSL-native event emission**: Events defined in ABL DSL, compiled to IR, version-controlled with agent definitions -- no runtime configuration drift
- **Unified observe + evaluate + improve**: Single platform from tracing through AI evaluation to optimization suggestions
- **Three-pattern event model**: Inline, guardrail, and async AI evaluation events flow into the same analytics system
- **Compliance-native**: Audit trails, encryption, PII handling, and tenant isolation built in from day one

---

## 2. Competitive Positioning

### Where We Win

| Differentiator                           | ABL Advantage                                                                       | Closest Competitor                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Declarative event emission**           | Events defined in ABL DSL, compiled to IR, version-controlled with agent definition | Braintrust (code-first), Datadog (UI-configured) |
| **Unified observe + evaluate + improve** | Single platform from tracing through AI evaluation to optimization suggestions      | Fragmented across 3-4 point solutions            |
| **Multi-tenant, multi-agent governance** | Tenant-isolated observability with cross-tenant insights                            | Few address this                                 |
| **Compliance-native**                    | Built-in audit trails, PII handling, encryption at rest -- not an afterthought      | Most bolt on compliance                          |
| **Three-pattern event model**            | Inline + guardrails + async AI evaluation in one unified event store                | No competitor unifies all three                  |

### Competitive Landscape Summary

**LLM Observability:** Arize (OTel-native, drift), LangSmith (Insights Agent, multi-turn), Braintrust (tightest eval loop), Datadog (APM integration), Langfuse (MIT, API-first)

**Enterprise CS:** Salesforce Agentforce ($540M ARR, full reasoning traces), Google CCAI (100% quality eval, topic discovery), Amazon Connect (deepest API), Microsoft D365 (with/without AI comparison), Intercom (AI gap analysis -- industry-leading feedback loop)

**Open Source:** Langfuse (MIT, 19K+ stars), Arize Phoenix (Apache 2.0), OTel GenAI conventions (experimental v1.36-1.37)

---

## 3. Strategic Rationale

### Why Now

1. **OTel GenAI conventions are still experimental.** The standard is not yet locked. Building OTel-native now means we shape the standard, not chase it.
2. **57% of organizations have agents in production** (LangChain, 1,340 respondents) but only 8.6% at scale. The analytics need is immediate and growing.
3. **100% AI evaluation is becoming baseline.** Google CCAI and Amazon Connect evaluate every conversation. This is rapidly becoming table stakes -- not a differentiator.
4. **Custom business events are non-negotiable.** Customers must emit their own events and build analytics on them. Our DSL-native approach is unique.
5. **The feedback loop is closing.** Observe-evaluate-improve is being semi-automated (Braintrust, Intercom, DSPy). Late entrants face a compounding disadvantage.

### Why Us

ABL controls the agent definition language (DSL), the compiler (IR), and the runtime. This means:

- Events are **version-controlled** with agent definitions
- Evaluation criteria **travel with the agent** (not configured in a separate platform)
- The runtime knows which events to emit at **compile time** (no runtime configuration drift)
- Event schemas are **derived from the DSL definition** (automatic validation)

No other platform has this architectural advantage.

---

## 4. Suggested Implementation Phases

| Phase         | Focus                               | Timeline | Key Outcomes                                                                                                                          |
| ------------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1**   | Foundation                          | Q1       | OTel tracing, latency/cost/error tracking, real-time dashboard, basic alerting                                                        |
| **Phase 2**   | Quality & Performance               | Q2       | Agent metrics, LLM-as-judge (100%), helpfulness scoring, comprehension failure detection, voice metrics                               |
| **Phase 3**   | Custom Events & Business            | Q3       | Inline event emission (SDK + DSL), unified event model, outcome classification, ROI tracking                                          |
| **Phase 3.5** | Async AI Evaluation                 | Q3-Q4    | Evaluation dispatcher, LLM-as-judge custom evaluators, DSL declarative evaluation criteria                                            |
| **Phase 4**   | AI Intelligence                     | Q4+      | Real-time intervention, AI optimization suggestions, anomaly detection, benchmark calibration                                         |
| **Phase 5**   | Platform & Conversational Analytics | Ongoing  | Conversational analytics interface (NL queries), semantic layer, conversation search, audit trails, regional analytics, BI connectors |

---

# PART II: PRODUCT SPECIFICATION

---

## 5. Feature Taxonomy

Seven tiers from foundational to advanced:

```
Tier 1: Operational Observability (Foundation)
  +-- OTel-native tracing, latency (P50/P95/P99), TTFT
  +-- Token usage & cost attribution, error rates
  +-- Model/provider reliability & drift detection
  +-- Real-time operational dashboards

Tier 2: Agent Performance Analytics
  +-- Quantitative (invocations, steps, tools, cost, containment)
  +-- Qualitative (goal completion, topic adherence, tonality, empathy)
  +-- Tool usage effectiveness (selection, parameter, retry, efficiency)
  +-- Reasoning quality (coherence, confidence calibration, self-correction)
  +-- RAG/knowledge retrieval (precision, recall, utilization, coverage)
  +-- Extraction effectiveness (accuracy, completeness, efficiency)
  +-- Multi-agent coordination, project-level rollup

Tier 3: Conversation & Quality Analytics
  +-- 100% quality evaluation (LLM-as-judge), sentiment progression
  +-- Helpfulness scoring, comprehension failure detection
  +-- Conversation efficiency (wasted turns, circular detection)
  +-- Multi-turn memory & consistency tracking
  +-- Topic/intent distribution, flow analysis, drop-off funnels
  +-- Safety, hallucination, guardrail effectiveness (FP/FN rates)
  +-- Conversation summarization, tagging & classification rules
  +-- Custom topic taxonomies, voice sentiment analysis

Tier 4: Business Outcome Analytics
  +-- CS metrics (containment, deflection, FCR), ROI & cost tracking
  +-- Human-AI collaboration metrics (handoff quality, blended resolution)
  +-- Voice channel metrics (WER, MOS, latency, barge-in, dead air)
  +-- Customer cohort analysis, A/B testing

Tier 5: Custom Event Emission & Business Metrics Platform
  +-- Inline event emission (SDK + ABL DSL declarative)
  +-- Synchronous guardrail events, async AI evaluation pipeline
  +-- Unified event model, event schema governance
  +-- Customer-defined evaluation criteria (no-code/low-code/pro-code)

Tier 6: AI-Powered Insights & Feedback Loops
  +-- Anomaly detection, AI root cause analysis
  +-- AI optimization suggestions, prompt/instruction tuning
  +-- Real-time intervention triggers (struggling user detection)
  +-- Benchmark calibration, metric maturity model
  +-- Eval->Improve iterative cycles
  +-- Predictive analytics (outcome prediction, CSAT prediction, churn risk)
  +-- Risk score monitoring (operational, quality, compliance, customer, cost)

Tier 7: Analytics Data Platform & APIs
  +-- Custom dashboards & report builder, drill-down investigation tools
  +-- Analytics APIs (REST/GraphQL), data export, BI connectors
  +-- Conversational analytics interface (NL queries over agent data)
  +-- Conversation search & discovery (keyword + semantic)
  +-- Conversation audit trails (compliance-ready)
  +-- Regional analytics & localization
  +-- AI-powered visualization generation
```

---

## 6. Tier 1: Operational Observability

### 6.1 End-to-End Tracing

OTel GenAI Semantic Conventions with hierarchical span structure:

```
Session -> Trace -> Agent Span -> LLM Span / Tool Span / Retriever Span /
                                  Guardrail Span / Evaluator Span / Handoff Span
```

**OTel standard attributes:** `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.agent.name`, `gen_ai.evaluation.result`

**ABL target:** 10 span kinds (CHAIN, LLM, TOOL, RETRIEVER, EMBEDDING, AGENT, RERANKER, GUARDRAIL, EVALUATOR, HANDOFF). Full context propagation across multi-agent handoffs.

### 6.2 Latency & Performance

| Metric                                        | Granularity                           |
| --------------------------------------------- | ------------------------------------- |
| End-to-end latency                            | P50, P95, P99                         |
| Time to first token (TTFT)                    | Per LLM call                          |
| LLM call duration                             | Per span                              |
| Tool execution duration                       | Per tool span                         |
| Retrieval latency (query -> rerank -> return) | Per retriever span                    |
| Queue/routing time                            | Per handoff                           |
| **Voice: Time to first byte (TTFB)**          | Per TTS call                          |
| **Voice: Time to first audio (TTFA)**         | End-to-end voice response             |
| **Voice: End-to-end voice latency**           | User speech end -> agent speech start |

### 6.3 Token Usage & Cost Attribution

- Per-model token tracking (input/output/reasoning tokens)
- Cost attribution by: tenant, project, agent, intent, customer segment, tool
- Budget alerts and spend tracking. Identify 5% of requests consuming 50% of tokens (Braintrust pattern).

### 6.4 Error Rates & System Health

- LLM API error rates (by provider, model, error type)
- Tool execution failure rates (by tool, error code)
- Guardrail trigger rates, rate limit events, system resource utilization
- **Voice: ASR error rates, TTS failures, audio codec issues**

### 6.5 Model/Provider Reliability & Drift Detection

| Metric                        | Description                                   | Detection Method                                                  |
| ----------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| **Input distribution drift**  | Statistical shift in user queries vs baseline | KL divergence on input embeddings                                 |
| **Output distribution drift** | Change in response characteristics over time  | Distribution comparison on response embeddings, length, sentiment |
| **Prompt drift**              | Production prompts diverging from baseline    | Embedding distance, entity/intent distribution shifts             |
| **Model degradation**         | Same model version performing worse over time | Quality score trending, latency changes                           |
| **Provider availability**     | Per-provider uptime and error rates           | Health check monitoring, error rate tracking                      |
| **Fallback trigger rate**     | How often system falls to alternate provider  | Count per time window                                             |
| **Semantic entropy**          | Output meaning variation for same input       | Multi-sample consistency scoring                                  |

**Who tracks this:** Fiddler AI (drift dashboards), Arize (embedding drift), Evidently AI (data/concept drift), Orq.ai (prompt drift)

### 6.6 Real-Time Dashboard

| Widget               | Frequency      | Purpose          |
| -------------------- | -------------- | ---------------- |
| Active conversations | Real-time      | Current load     |
| Error rate           | 5-min rolling  | System health    |
| Avg response latency | 5-min rolling  | Performance      |
| Escalation rate      | 15-min rolling | Quality signal   |
| Token spend rate     | 15-min rolling | Cost             |
| Top intents          | 15-min rolling | Traffic patterns |
| Provider status      | Real-time      | Reliability      |

---

## 7. Tier 2: Agent Performance Analytics

### 7.1 Quantitative Metrics (per agent, per time period)

| Metric                     | Description                         |
| -------------------------- | ----------------------------------- |
| Invocation count           | Times the agent was called          |
| Step execution count       | Total steps across all invocations  |
| Tool invocation count      | Tool calls made                     |
| Tool success rate          | % of tool calls that succeeded      |
| Avg steps per conversation | Efficiency measure                  |
| Avg turns to resolution    | Conversation length to resolution   |
| Containment rate           | Resolved without escalation/handoff |
| Escalation rate            | Passed to another agent or human    |
| Error rate                 | Invocations resulting in errors     |
| Avg cost per invocation    | Token + tool costs per call         |

### 7.2 Qualitative Metrics (LLM-as-judge)

| Metric                | Method                           | Description                                              |
| --------------------- | -------------------------------- | -------------------------------------------------------- |
| Goal completion       | LLM judge + outcome verification | Achieved defined objective?                              |
| Topic adherence       | Semantic drift detection         | Stayed on-topic per instructions?                        |
| Instruction following | LLM judge against agent def      | Persona/guardrail/style followed?                        |
| Response relevance    | LLM judge + embedding similarity | Relevant to user queries?                                |
| Response accuracy     | Claim extraction + verification  | Factual claims correct?                                  |
| Message tonality      | Sentiment + style analysis       | Appropriate tone maintained?                             |
| Empathy score         | LLM judge                        | Acknowledged user emotions?                              |
| Safety compliance     | Classifier + guardrail checks    | Safety guidelines followed?                              |
| **Helpfulness score** | LLM judge (1-5 rubric)           | Actionable value provided? (Not just "pretty sentences") |

### 7.3 Tool Usage Effectiveness

| Metric                          | Description                            | Why It Matters                                                    |
| ------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| **Tool selection accuracy**     | Right tool for the task?               | Agent can succeed at wrong tool call -- measures decision quality |
| **Parameter/argument accuracy** | Correct, valid parameters?             | `currency: "dollars"` when enum expects `"USD"` is wrong          |
| **Tool retry rate**             | How often same tool retried?           | High retries = poor param generation or flaky integrations        |
| **Tool call sequence accuracy** | Multi-tool workflows in correct order? | `authenticateUser()` must precede `fetchUserData()`               |
| **Tool call efficiency**        | Actual vs optimal tool calls           | 12 calls vs 3 for same outcome = wasted cost/latency              |
| **Unused tool rate**            | Available tools never invoked          | Suggests misconfiguration or unnecessary tool bindings            |

**Who tracks this:** DeepEval (`ToolCorrectnessMetric`), Portkey, Braintrust, Berkeley Function-Calling Leaderboard

### 7.4 Reasoning Quality & Decision Metrics

| Metric                              | Description                                                 | Why It Matters                                                           |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Reasoning coherence score**       | Multi-step reasoning follows logical chain?                 | Individual steps can be correct but overall path incoherent              |
| **Decision confidence calibration** | When agent says 80% confident, is it right 80% of the time? | ECE (Expected Calibration Error) -- prevents overconfident wrong answers |
| **Self-correction rate**            | How often agent catches own mistakes?                       | Indicates metacognitive capability                                       |
| **Planning effectiveness**          | For multi-step tasks, how good were plans?                  | Plan quality directly predicts task success                              |
| **Autonomous task completion**      | Tasks completed end-to-end without human intervention       | North star for agent autonomy. Top agents: 85-95% on structured tasks    |
| **Routing decision precision**      | Supervisor handoff/delegate accuracy                        | Misrouting creates cascading failures                                    |

**Who tracks this:** LangSmith, Galileo AI, Anthropic evals, AWS agent evaluation

### 7.5 RAG / Knowledge Retrieval Metrics

| Metric                         | Description                                      | Formula/Method                     |
| ------------------------------ | ------------------------------------------------ | ---------------------------------- |
| **Retrieval precision@K**      | % of retrieved docs that are relevant            | Relevant in top K / K              |
| **Retrieval recall@K**         | % of all relevant docs captured                  | Relevant in top K / Total relevant |
| **MRR (Mean Reciprocal Rank)** | Rank of first relevant result                    | 1/rank, averaged across queries    |
| **Context utilization**        | % of retrieved context actually used in response | Used chunks / Retrieved chunks     |
| **Knowledge base coverage**    | % of queries with relevant articles              | Queries with match / Total queries |
| **Citation coverage**          | % of sourced claims with proper citations        | Cited claims / Total claims        |
| **Stale knowledge rate**       | Responses based on outdated info                 | Age analysis of source documents   |
| **Answer source attribution**  | Which articles power which responses             | Source tracking per response       |

**Who tracks this:** RAGAS, Patronus AI, Pinecone, Weaviate, Evidently AI

### 7.6 Comprehension & Understanding Metrics

| Metric                            | Description                                  | Formula                                                 |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| **Fallback rate**                 | "I didn't understand" responses              | Fallback responses / Total messages x 100               |
| **NLU accuracy**                  | Correctly matched to known intents           | Correct classifications / Total x 100 (target: 85-90%+) |
| **NLU false positive rate**       | Misclassified despite high confidence        | Overconfident wrong answers erode trust                 |
| **Repeated rephrasing detection** | User asks same question 2+ times differently | Cosine similarity >0.85 across consecutive user turns   |
| **Circular conversation rate**    | Topic recurs after apparent resolution       | Same intent/entity reappears after 3+ turns             |
| **Low confidence streaks**        | Bot confidence <0.6 for 2+ consecutive turns | Auto-flag for escalation or review                      |

**Who tracks this:** Zendesk (fallback rate), Kore.ai (NLU coverage gaps), ChatBench, Calabrio

### 7.7 Extraction & Information Gathering (ABL-specific)

| Metric                      | Description                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------- |
| **Extraction accuracy**     | Were correct values extracted from user messages?                                      |
| **Extraction completeness** | Were all required fields gathered before proceeding?                                   |
| **Extraction efficiency**   | Turns to gather all required info (actual vs optimal)                                  |
| **Clarification rate**      | How often agent asks clarifying questions (too many = poor NLU; too few = assumptions) |

### 7.8 Multi-Agent Coordination

| Metric                         | Description                                                            |
| ------------------------------ | ---------------------------------------------------------------------- |
| Handoff accuracy               | Routed to correct specialist agent?                                    |
| Handoff latency                | Time in routing/delegation overhead                                    |
| Context preservation score     | Relevant context maintained across handoffs?                           |
| Resolution depth               | Agent-to-agent transitions before resolution                           |
| Agent utilization distribution | Work distribution (bottleneck detection)                               |
| Redundant work rate            | Multiple agents duplicating effort?                                    |
| Escalation reason distribution | Why agents escalate (capability gap, confidence, user request, policy) |

### 7.9 Project-Level Rollup

```
Project Dashboard
+-- Overall containment rate (weighted across agents)
+-- Overall resolution quality (avg quality scores)
+-- Total cost & cost trends
+-- Agent comparison table (side-by-side metrics)
+-- Worst-performing agents (quality x volume)
+-- Most expensive agents (cost per resolution)
+-- Improvement trends (quality scores over time)
```

**Microsoft D365 pattern:** Show "with AI" vs "without AI" to quantify improvement.

---

## 8. Tier 3: Conversation & Quality Analytics

### 8.1 100% Conversation Quality Evaluation

Following Google CCAI and Amazon Connect -- evaluate every conversation, not a sample.

| Dimension          | Score     | Description                            |
| ------------------ | --------- | -------------------------------------- |
| Resolution quality | 1-5       | Issue actually resolved correctly?     |
| Response accuracy  | 1-5       | Factual claims correct and supported?  |
| Helpfulness        | 1-5       | Actionable value provided?             |
| Coherence          | 1-5       | Logically consistent?                  |
| Professionalism    | 1-5       | Appropriate tone, language, formatting |
| Safety             | Pass/Fail | No harmful or policy-violating content |
| PII handling       | Pass/Fail | PII properly handled per compliance    |

**Composite CX Score (Intercom pattern):** AI-generated customer experience score per conversation with plain-language explanations -- no surveys. Covers 100% of conversations vs 5-15% survey response rates.

### 8.2 Helpfulness & AI Effectiveness Scoring

| Metric                           | Description                                                | Formula/Method                                                                   |
| -------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Information gain per turn**    | Did each response add value and move conversation forward? | (Relevant turns / Total turns) x 100                                             |
| **Task progression rate**        | Is conversation moving toward resolution?                  | Progress milestones reached / Expected milestones                                |
| **Bot repetition rate**          | Frequency of repeated responses/questions                  | Repeated responses / Total bot responses x 100 (target: <5%)                     |
| **Wasted turn rate**             | Turns that don't progress conversation                     | Redundant tool calls, circular clarifications, exploratory turns with no outcome |
| **Conversation flow efficiency** | No latency spikes, no loops, forward progression           | Composite of repetition, loop, and progression signals                           |
| **Resolution accuracy**          | Did agent both answer the question AND was it useful?      | Two-dimensional: factual + practical                                             |
| **Knowledge retention score**    | Does agent correctly retain info across turns?             | (Turns with retained info / Total turns) x 100                                   |

**Helpfulness rubric for LLM-as-judge:**

- **5 (Excellent):** Clear, relevant, actionable with specific next steps
- **4 (Good):** Addresses query with useful detail
- **3 (Adequate):** Addresses query but lacks actionable guidance
- **2 (Poor):** Vague, off-topic, or lacks substance
- **1 (Unhelpful):** No value -- verbose but empty, or completely wrong

### 8.3 User Struggle & Friction Detection

Detect customers who are having a bad experience _before_ they explicitly complain.

**Behavioral signals (zero-cost, no AI needed):**

| Signal                            | Detection                                                           | Threshold                              |
| --------------------------------- | ------------------------------------------------------------------- | -------------------------------------- |
| **User rephrasing**               | Cosine similarity >0.85 across consecutive user turns               | 2+ rephrasings = comprehension failure |
| **User message length trend**     | Increasing length within conversation                               | Monotonic increase over 3+ turns       |
| **User response time**            | Long delays between user messages                                   | >2x user's average for that session    |
| **Explicit frustration language** | "This isn't working", "let me talk to a person", ALL CAPS, !!!, ??? | Keyword/regex detection                |
| **Turn count outlier**            | Session exceeding 2.5 sigma above mean for same intent              | Z-score: `(x - mu) / sigma > 2.5`      |
| **Repeat contact**                | Same customer, same issue within 24-72 hours                        | Customer + intent matching             |
| **Channel switch**                | User started on AI chat, moved to phone                             | Cross-channel journey tracking         |

**Friction score (composite):**

```
Friction_Score = w1*(Rephrasing_Count) + w2*(Sentiment_Decline) +
                 w3*(Turn_Count_ZScore) + w4*(Low_Confidence_Turns) +
                 w5*(Loop_Detection_Flag) + w6*(Explicit_Frustration)
```

### 8.4 Sentiment Analysis & Progression

- Turn-level sentiment scoring (positive/neutral/negative) for both user and agent
- Sentiment trajectory (improving, stable, declining)
- Frustration detection (repeated questions, explicit complaints, escalation requests)
- Sentiment pivot point identification (which responses cause shifts?)

**Patterns to detect:**

- **Recovery:** Negative -> resolved -> improves (ideal)
- **Degradation:** Neutral -> agent fails -> declines -> escalation/abandon
- **Frustrated loop:** Oscillates as user rephrases and agent repeatedly fails

**Voice sentiment analysis (channel-specific):**

| Metric                        | Description                                                    | Method                                                  |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| **Acoustic sentiment**        | Emotion from tone, pitch, speaking rate (independent of words) | Prosody analysis, voice emotion recognition models      |
| **Linguistic sentiment**      | Emotion from transcribed text content                          | NLP sentiment on ASR transcript                         |
| **Composite voice sentiment** | Weighted fusion of acoustic + linguistic signals               | `0.6 * acoustic + 0.4 * linguistic` (tunable)           |
| **Caller stress level**       | Elevated pitch, faster speech, breath patterns                 | Acoustic feature extraction                             |
| **Silence-after-agent**       | Long pause after agent response = confusion/frustration        | Duration analysis per turn                              |
| **Escalation tone detection** | Voice patterns preceding explicit escalation requests          | Pattern matching on acoustic features before escalation |

**Voice-specific patterns:** Acoustic signals often precede linguistic expression of frustration by 2-3 turns. Track acoustic sentiment as a **leading indicator** for proactive intervention.

### 8.5 Multi-Turn Memory & Consistency

| Metric                         | Description                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| **Consistency index**          | Contradictions across turns? ("Ships Monday" in turn 3, "ships Wednesday" in turn 7) |
| **Memory recall accuracy**     | Correctly recalls earlier context?                                                   |
| **Entity tracking accuracy**   | Tracks entities (account numbers, dates, names) introduced earlier?                  |
| **Context window utilization** | % of context used for relevant vs redundant information                              |
| **Session continuity score**   | After session resume, maintains coherence with prior conversation?                   |

### 8.6 Topic/Intent Distribution & Discovery

- Volume distribution across intents (with sub-intent granularity)
- Intent trends over time (daily/weekly/monthly seasonality)
- **Unsupervised topic discovery** (Google CCAI pattern): ML detection of emerging topics not in configured taxonomy
- Intent co-occurrence and intent-to-outcome mapping

**Custom topic taxonomies:**

Customers define their own topic/intent hierarchies rather than using a fixed taxonomy:

| Capability                        | Description                                                               |
| --------------------------------- | ------------------------------------------------------------------------- |
| **Hierarchical taxonomy builder** | Define multi-level topic trees (e.g., Billing > Refunds > Partial Refund) |
| **Auto-classification rules**     | Map conversations to topics via keyword, intent, or LLM classifier        |
| **Taxonomy versioning**           | Track taxonomy changes over time; re-classify historical data on update   |
| **Cross-taxonomy mapping**        | Map between customer taxonomy and platform default for benchmarking       |
| **Topic drift alerts**            | Alert when significant volume moves to "uncategorized" (taxonomy gap)     |

Topic taxonomies are tenant-scoped and stored in MongoDB. Classification runs as an async evaluation (Pattern 3) using the customer's taxonomy definition as LLM context.

### 8.7 Conversation Flow Analysis

- **Path analysis:** Most common paths with Sankey visualization
- **Drop-off funnels:** At which step do users abandon?
- **Loop detection:** Conversations revisiting same step/topic (indicates confusion)
- **Escalation points:** Which step triggers escalation most?
- **Turn efficiency:** Minimum possible turns / actual turns

### 8.8 Safety, Compliance & Guardrail Effectiveness

**Safety tracking:** Toxicity detection (user + agent), PII detection, prompt injection attempts, jailbreak tracking, regulatory disclosure verification, guardrail trigger rate by type

**Guardrail effectiveness (beyond trigger rates):**

| Metric                        | Description                                            |
| ----------------------------- | ------------------------------------------------------ |
| **False positive rate**       | Legitimate content blocked -- creates user frustration |
| **False negative rate**       | Bad content slipping through -- compliance risk        |
| **Guardrail bypass rate**     | Users finding ways around guardrails                   |
| **Policy violation severity** | Not just count -- low / medium / critical distribution |

### 8.9 Hallucination & Accuracy

| Method                    | Approach                                       | Use Case                     |
| ------------------------- | ---------------------------------------------- | ---------------------------- |
| RAGAS Faithfulness        | Extract claims, verify against context         | RAG responses                |
| SelfCheckGPT              | Multi-sample consistency                       | General factual claims       |
| NLI-based groundedness    | NLI model verification                         | Grounded on retrieved docs   |
| FActScore                 | Atomic fact decomposition                      | Detailed accuracy audit      |
| Context Sensitivity Ratio | Token probability comparison with/without docs | Pinpoint hallucinated tokens |

**Tracked:** Hallucination rate, accuracy score, groundedness score, contradiction rate (self-contradictions within conversation)

### 8.10 Conversation Summarization

Auto-generate structured summaries for every conversation (Google CCAI, Observe.AI pattern):

| Component                  | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| **Executive summary**      | 1-2 sentence plain-language summary of the interaction         |
| **Key topics discussed**   | Extracted topic/intent list with time spent on each            |
| **Actions taken**          | Tools called, information gathered, decisions made             |
| **Outcome & next steps**   | Resolution status, pending actions, follow-up needed           |
| **Customer sentiment arc** | Start → middle → end sentiment with key pivot points           |
| **Risk flags**             | Churn signals, compliance issues, escalation triggers detected |

**Implementation:** Async AI evaluation (Pattern 3) using conversation transcript + agent trace as context. LLM generates structured JSON summary. Summaries stored in ClickHouse `conversation_summaries` table for search and aggregation. Summarization cost: ~$0.002/conversation with GPT-4o-mini.

**Use cases:** Agent performance review, supervisor dashboards, compliance audit, training data curation, conversation search (search over summaries instead of full transcripts).

### 8.11 Conversation Tagging & Classification Rules

Customer-defined tagging rules that automatically classify conversations:

| Rule Type          | Example                                                                | Mechanism                             |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------- |
| **Keyword-based**  | Tag "VIP" if customer tier = "enterprise"                              | Field matching                        |
| **Pattern-based**  | Tag "Complaint" if 2+ negative sentiment turns                         | Behavioral pattern                    |
| **LLM-classified** | Tag "Upsell Opportunity" if customer expresses interest in upgrade     | LLM judge evaluation                  |
| **Outcome-based**  | Tag "Needs Follow-Up" if outcome = "partially_resolved"                | Outcome matching                      |
| **Composite**      | Tag "At Risk" if (negative sentiment AND repeat contact AND escalated) | Boolean logic across multiple signals |

**Tag management:**

- Tags are tenant-scoped, defined in MongoDB
- Tags can be hierarchical (parent/child)
- Auto-tags applied via async evaluation pipeline; manual tags via UI/API
- Tag-based filtering available across all dashboards and analytics queries
- Tag frequency trends tracked over time (e.g., "Complaint" tags increasing this week)

---

## 9. Tier 4: Business Outcome Analytics

### 9.1 Core Customer Service Metrics

| Metric                       | Formula                                            | Benchmark          |
| ---------------------------- | -------------------------------------------------- | ------------------ |
| **Containment rate**         | Fully resolved by AI / Total AI interactions x 100 | 50-70% blended     |
| **Deflection rate**          | AI-resolved / Would-have-contacted-human x 100     | 60-80%             |
| **First contact resolution** | Resolved on first interaction / Total x 100        | 70-80%             |
| **Avg handle time (AI)**     | Avg time from first message to resolution          | 30s-5min by intent |
| **Escalation rate**          | Transferred to human / Total AI interactions x 100 | 20-40%             |
| **Drop-off/abandonment**     | Abandoned without resolution / Total x 100         | <15% target        |
| **Resolution accuracy**      | Correctly resolved / Total resolved x 100          | 95%+ target        |
| **Customer effort score**    | Post-interaction survey (1-7)                      | >5.5 target        |
| **Repeat contact rate**      | Same customer + issue within 24-72h / Total x 100  | <10% target        |

**Critical:** Containment != Deflection. High deflection + low containment = turning customers away unsolved. Track both.

**Verified containment:** Track whether "contained" conversations result in repeat contact within 24-72h. False containment is a major risk.

### 9.2 Voice Channel Metrics

| Metric                                   | Description                              | Benchmark/Target               |
| ---------------------------------------- | ---------------------------------------- | ------------------------------ |
| **Word Error Rate (WER)**                | ASR transcription errors                 | <10% (good), <5% (excellent)   |
| **Mean Opinion Score (MOS)**             | Perceived TTS voice quality (1-5)        | >4.0 target                    |
| **Time to First Byte (TTFB)**            | Latency from request to first audio byte | <200ms                         |
| **Time to First Audio (TTFA)**           | End-to-end voice response start          | <500ms                         |
| **End-to-end voice latency**             | User speech end -> agent speech start    | <800ms target                  |
| **Barge-in detection rate**              | User interrupts agent mid-utterance      | Track rate + handle gracefully |
| **Dead air / silence duration**          | Pauses >2s during conversation           | <3% of call duration           |
| **Turn-taking latency**                  | Gap between speaker transitions          | <500ms (natural feel)          |
| **Overlap / crosstalk rate**             | Simultaneous speech events               | <5% of turns                   |
| **Signal-to-Noise Ratio (SNR)**          | Audio quality of input                   | >15dB for reliable ASR         |
| **Prosody / naturalness score**          | TTS intonation, rhythm, stress patterns  | LLM judge or MOS variant       |
| **Multi-language/accent accuracy**       | WER segmented by language/accent         | Track per-language WER         |
| **DTMF fallback rate**                   | Users resorting to keypad input          | Lower = better voice UX        |
| **Voice containment rate**               | Calls resolved without human transfer    | 40-60% target                  |
| **Call abandonment rate**                | Callers hanging up before resolution     | <15% target                    |
| **Voice CSAT**                           | Post-call satisfaction                   | Compare to chat CSAT           |
| **Repeat caller rate**                   | Same caller + issue within 24-72h        | <10% target                    |
| **Conversation pacing**                  | Words per minute, appropriate speed      | 120-160 WPM                    |
| **Confirmation/clarification loop rate** | "Did you say...?" cycles                 | <15% of turns                  |

**Voice-specific patterns to detect:**

- **ASR cascade failure:** Poor audio -> high WER -> intent misclassification -> wrong response -> escalation
- **Latency-induced abandonment:** Long pauses cause caller to hang up or press 0
- **Barge-in frustration:** Caller repeatedly interrupts verbose agent responses

### 9.3 Granular Outcome Classification

Beyond resolved/escalated/abandoned:

| Outcome                      | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| **Fully resolved**           | Issue completely addressed                                      |
| **Partially resolved**       | Issue partially addressed (e.g., 2 of 3 items refunded)         |
| **Escalated (proactive)**    | AI detected frustration/complexity, escalated before user asked |
| **Escalated (user request)** | User explicitly asked for human                                 |
| **Escalated (pre-emptive)**  | Agent escalated before attempting resolution (over-cautious)    |
| **Misdirected**              | Routed to wrong flow, had to restart                            |
| **Stalled**                  | Conversation went silent -- user lost interest                  |
| **Abandoned**                | User left without resolution or escalation                      |
| **Duplicate**                | Same issue as previous conversation (repeat contact)            |
| **Resolved with workaround** | Solved through suboptimal path                                  |

### 9.4 Human-AI Collaboration Metrics

| Metric                                         | Description                                                    | Why It Matters                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Handoff context quality**                    | Sufficient context passed to human?                            | 80% of users trust chatbots only if human option exists -- poor handoffs destroy trust |
| **Human handle time post-escalation**          | Did AI pre-processing reduce human work?                       | Quantifies AI assist value                                                             |
| **Human override rate**                        | Human disagrees with / undoes AI actions                       | Signal for AI accuracy                                                                 |
| **Blended resolution quality**                 | CSAT for partly-AI, partly-human conversations                 | End-to-end quality view                                                                |
| **Time to human response**                     | Queue wait after AI hands off                                  | Long waits make escalation itself negative                                             |
| **Agent assist utilization**                   | When AI suggests responses, how often accepted?                | Human-AI collaboration effectiveness                                                   |
| **Sentiment-triggered vs explicit escalation** | % proactive (AI detected frustration) vs reactive (user asked) | Proactive = better experience                                                          |
| **Post-handoff FCR**                           | Human resolves on first try after escalation?                  | Measures handoff completeness                                                          |

### 9.5 Customer-Defined Business Events

ABL provides **tooling for customers to define, emit, and analyze their own business events** (not pre-built industry templates). Every enterprise has unique KPIs:

- Banking: `Payment Completed` with amount, method, currency
- Insurance: `Policy Renewal Declined` with reason, type, tenure
- Pharma: `Drug Return Initiated` with drug name, reason, quantity
- Travel: `Booking Cancelled` with days since booking, reason, segment

The three-pattern event emission framework (Section 10) enables this.

### 9.6 ROI & Cost Tracking

| Metric                         | Description                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Cost per AI interaction        | LLM + infrastructure + tool execution                                        |
| Cost per contained interaction | AI cost for successfully resolved                                            |
| Cost per escalated interaction | AI cost + human cost for escalated                                           |
| Total cost savings             | AI-contained volume x (human cost - AI cost)                                 |
| **True cost per conversation** | Platform cost + (escalation rate x agent cost) + (repeat rate x rework cost) |

**ROI formula:** `Annual ROI = [(Savings + Revenue + Productivity) - (Platform + Implementation)] / Total Investment x 100`

**Microsoft D365 pattern:** Show every metric "with AI" vs "without AI."

### 9.7 Customer Cohort Analysis & A/B Testing

**Cohort segmentation:** Customer tier, tenure, channel, AI experience, issue complexity, geography, product line.

**A/B testing:** Prompt variations, model versions, flow designs, escalation thresholds, response styles. Requires consistent per-user session assignment, statistical significance (p<0.05), and safety guardrails (auto-rollback on quality degradation).

---

## 10. Tier 5: Custom Event Emission & Business Metrics Platform

### 10.1 The Three-Pattern Event Model

```
Pattern 1: INLINE EMISSION (Sync, developer-defined)
  Explicit emit() during execution. Customer decides WHAT and WHEN.
  Cost: Zero. Latency: Negligible.

Pattern 2: SYNCHRONOUS GUARDRAILS (Sync, blocking)
  AI checks on request path -- block/modify response + emit pass/fail.
  Examples: PII detection, compliance, jailbreak prevention.
  Cost: Per-check model cost. Latency: Added to response time.

Pattern 3: ASYNC AI EVALUATION (Async, AI-powered)
  Post-interaction screening for qualitative metrics. Background, zero latency.
  Cost: Per-eval x sampling rate. Latency: None on request path.

All three -> SAME analytics system via unified event model.
```

### 10.2 Pattern 1: Inline Event Emission

**SDK pattern (imperative):**

```typescript
async function processPayment(params: PaymentParams, context: ToolContext) {
  const result = await paymentService.process(params);
  context.analytics.emit('Payment Completed', {
    amount: result.amount,
    currency: result.currency,
    method: result.paymentMethod,
    status: result.status,
  });
  return result;
}
```

**Declarative pattern (ABL DSL -- unique differentiator):**

```
agent BillingAgent {
  tools {
    process_payment {
      on_success {
        emit "Payment Completed" {
          amount: response.amount
          method: response.payment_method
          above_threshold: response.amount > 5000
        }
      }
    }
  }
}
```

Events are version-controlled with agent definition, compiled into IR, validated at compile time. No runtime configuration drift. **Significant differentiator** vs. Braintrust (code-first), Datadog (UI-configured), Langfuse (API-driven).

**Naming taxonomy (Segment Object-Action):** `Payment Completed`, `Policy Renewed`. Title Case events, snake_case properties. Never dynamic event names.

### 10.3 Pattern 2: Synchronous Guardrail Events

Guardrails emit pass/fail AND act (block, modify, escalate):

- PII detection -> `PII Detected` -> redact/block
- Compliance check -> `Disclosure Missing` -> inject disclosure
- Jailbreak detection -> `Jailbreak Attempt` -> block response

### 10.4 Pattern 3: Async AI Evaluation Pipeline

```
Request Path -> [Trace Emitters] -> Event Bus (Redis Streams/Kafka)
  -> Evaluation Dispatcher (sampling, fan-out)
    -> Code Scorers | LLM Judge | ML Model
      -> Score Writer -> Unified Event Store -> Alert Engine
```

**Tiered criteria definition:**

| Tier         | Approach                             | Example                             |
| ------------ | ------------------------------------ | ----------------------------------- |
| **No-code**  | Scorecard questions (Google CCAI)    | "Did agent verify identity?" Yes/No |
| **Low-code** | Natural language criteria (Datadog)  | "Rate helpfulness 1-5"              |
| **Pro-code** | Custom scorer functions (Braintrust) | Full TypeScript/Python logic        |

**ABL DSL declarative evaluations (unique):**

```
project MyProject {
  evaluations {
    "Churn Intent Detection" {
      when: conversation.end
      type: llm_judge
      prompt: "Did the customer express intent to cancel or leave?"
      output: categorical ["churn_intent", "no_churn_intent", "unclear"]
      sampling: 100%
    }
  }
}
```

### 10.5 Cost of AI Evaluation

| Volume   | Model       | 100% Cost/Month | 10% Sample |
| -------- | ----------- | --------------- | ---------- |
| 10K/day  | GPT-4o-mini | ~$40            | ~$4        |
| 100K/day | GPT-4o-mini | ~$405           | ~$40       |
| 1M/day   | GPT-4o-mini | ~$4,050         | ~$405      |

**Sampling strategies:** 100% for low volume / compliance, stratified for segments, code-first + LLM-second for cost optimization, anomaly-triggered for efficiency.

### 10.6 Unified Event Model

```typescript
interface PlatformEvent {
  id: string;
  name: string; // "Payment Completed", "Churn Intent Detected"
  version: string; // Schema version
  source: 'inline' | 'evaluator' | 'guardrail';
  emitter: string; // Tool name or evaluator ID
  tenantId: string;
  sessionId: string;
  traceId: string;
  observationId?: string;
  dataType: 'numeric' | 'categorical' | 'boolean' | 'structured';
  value: number | string | boolean | Record<string, unknown>;
  properties: Record<string, unknown>;
  confidence?: number; // For AI events: 0-1
  reasoning?: string; // For AI events: explanation
  timestamp: Date;
  evaluatedAt?: Date;
  schemaId?: string;
}
```

**Rules:** Both inline and AI events in same store/dashboards. `source` distinguishes origin. AI events include confidence/reasoning. Schema validation on both. Inline = immediate; AI = seconds-to-minutes delay.

### 10.7 Event Schema Governance

Event catalog with declarative schemas (name, properties, types, required/optional). Platform validates at emission time. Backward-compatible evolution via expand-contract pattern. Semantic versioning (major = breaking, minor = additive, patch = docs).

---

## 11. Tier 6: AI-Powered Insights & Feedback Loops

### 11.1 Automated Anomaly Detection & Alerting

| Metric                  | Warning              | Critical              | Window |
| ----------------------- | -------------------- | --------------------- | ------ |
| Containment rate drop   | >10% below baseline  | >20% below baseline   | 1h     |
| Error rate              | >2%                  | >5%                   | 15m    |
| Escalation rate spike   | >15% above normal    | >30% above normal     | 30m    |
| Response latency        | >5s                  | >10s                  | 5m     |
| Drop-off rate           | >20% above normal    | >35% above normal     | 1h     |
| Negative sentiment rate | >25%                 | >40%                  | 1h     |
| Hallucination rate      | >5%                  | >10%                  | 1h     |
| Helpfulness score drop  | >15% below baseline  | >25% below baseline   | 1h     |
| **Voice WER spike**     | >15%                 | >25%                  | 30m    |
| **Voice dead air rate** | >5% of call duration | >10% of call duration | 30m    |

**Detection:** Threshold-based, ML anomaly detection (Datadog), semantic drift (Arize), evaluation-triggered.

### 11.2 Real-Time Intervention & Struggling User Detection

**Escalation score formula:**

```
Escalation_Score = w1*(Sentiment) + w2*(Confidence) + w3*(Loop_Flag) +
                   w4*(SLA_Risk) + w5*(Customer_Tier) + w6*(Failed_Attempts)

If Escalation_Score > Threshold -> Trigger Intervention
```

**Primary triggers:**

| Trigger                         | Signal                                           | Action                     |
| ------------------------------- | ------------------------------------------------ | -------------------------- |
| **Confidence collapse**         | AI confidence <0.6 for 2+ turns                  | Offer human handoff        |
| **Comprehension loop**          | 3+ user rephrasings (cosine >0.85)               | Auto-escalate              |
| **Sentiment degradation**       | Score drops below -0.5 or 3+ turn negative trend | Proactive escalation       |
| **Turn count outlier**          | >2.5 sigma above mean for this intent            | Flag + offer escalation    |
| **Explicit request**            | "Talk to a person", "this isn't working"         | Immediate transfer         |
| **SLA risk**                    | Approaching breach (ML prediction)               | Priority routing           |
| **High friction score**         | Composite friction exceeds threshold             | Supervisor alert           |
| **Voice: extended dead air**    | >5s silence after user speech                    | Re-engage or escalate      |
| **Voice: repeated ASR failure** | 3+ "I didn't catch that"                         | Switch to DTMF or escalate |

**Handoff package (must include):** Full transcript, customer data/CRM profile, collected info, specific escalation reason, actions attempted, tools called, current sentiment/context flags.

### 11.3 AI Root Cause Analysis

1. **Embedding clustering** (Arize): Groups failing traces by semantic similarity
2. **Trace decomposition** (Datadog, Langfuse): Identifies which component contributes most to failures
3. **LLM diagnosis** (Grafana SRE Agent): Natural-language root cause hypotheses
4. **Fiddler pattern:** Events -> distribution analysis -> drill-down -> automated identification

### 11.4 AI-Powered Optimization Suggestions

**Intercom pattern (industry-leading):** Analyze all failed conversations, identify three gap types:

| Gap             | Example                                                       |
| --------------- | ------------------------------------------------------------- |
| **Content gap** | "Billing FAQ doesn't cover international wire transfers"      |
| **Data gap**    | "Agent can't access account balance -- needs CRM integration" |
| **Action gap**  | "Agent can identify the issue but can't initiate a refund"    |

Impact-scored by volume, delivered as weekly prioritized recommendations.

**ABL extension:** Since ABL controls agent definition (DSL), suggestions target specific AST nodes:

- "Add tool binding for `refund_initiation` -- 34 conversations failed because capability missing"
- "Add extraction field for `account_type` to routing supervisor -- 12% of handoffs misdirected"
- "Lower escalation threshold from 8 to 5 turns -- sentiment shows frustration starts at turn 5"

### 11.5 Automated Prompt/Instruction Tuning

- **DSPy:** COPRO (coordinate ascent), MIPROv2 (Bayesian optimization), SIMBA (mini-batch sampling)
- **Braintrust Loop:** Production traces -> test cases -> experiments -> CI/CD gates
- **ABL-specific:** Improvement suggestions can target system prompt, tool descriptions, extraction hints, routing rules, guardrail thresholds

### 11.6 Structured Improvement Workflow

```
CAPTURE -> EVALUATE -> IDENTIFY -> CURATE -> EXPERIMENT -> COMPARE -> GATE -> DEPLOY -> MONITOR -> REPEAT
```

Production traces -> LLM-as-judge scoring -> anomaly detection + clustering -> failing traces become eval datasets -> new versions tested offline -> statistical comparison -> CI/CD gates -> staged rollout + A/B -> real-time post-deploy eval -> continuous cycle.

### 11.7 Predictive Analytics & Risk Scoring

AI-powered forward-looking predictions derived from conversation data and historical patterns:

#### Conversation Outcome Prediction

| Model                             | Input Features                                                                       | Output                                              | Use Case                                    |
| --------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------- |
| **Real-time outcome predictor**   | Turn count, sentiment trajectory, intent, agent confidence, tool success rate        | Probability distribution over 10 outcome categories | Mid-conversation intervention decisions     |
| **Escalation probability scorer** | Current friction score, sentiment, topic complexity, agent capability, customer tier | 0-1 escalation probability                          | Proactive routing to human before user asks |
| **Resolution time predictor**     | Intent, current turn, historical resolution times, agent performance                 | Estimated remaining turns/time                      | SLA management, queue prioritization        |

**Implementation:** Lightweight ML models (gradient boosted trees) trained on historical conversation outcomes. Updated weekly per tenant. Predictions emitted as platform events (`source: 'ml_model'`) and available for real-time intervention triggers.

#### Customer Satisfaction Prediction (AI-Inferred CSAT)

Predict CSAT without surveys, covering 100% of conversations (vs. 5-15% survey response rates):

| Signal                   | Weight | Description                             |
| ------------------------ | ------ | --------------------------------------- |
| Resolution quality score | 0.25   | LLM-judge assessment                    |
| Sentiment trajectory     | 0.20   | Improving = higher predicted CSAT       |
| Turn efficiency          | 0.15   | Fewer turns relative to intent = better |
| Friction score (inverse) | 0.15   | Lower friction = higher predicted CSAT  |
| Helpfulness score        | 0.15   | Direct utility measure                  |
| Outcome category         | 0.10   | Fully resolved > partially > escalated  |

**Calibration:** Train against actual CSAT survey responses (where available). Track predicted-vs-actual correlation monthly. Target: Spearman rho >= 0.75.

#### Churn Risk from Conversations

| Signal                                           | Churn Indicator | Action                               |
| ------------------------------------------------ | --------------- | ------------------------------------ |
| **Repeat contacts (3+ in 7 days)**               | High            | Priority routing, proactive outreach |
| **Escalation + negative sentiment + unresolved** | High            | Customer success alert               |
| **Declining CSAT trend (3+ conversations)**      | Medium          | Account health review                |
| **Competitor mention in transcript**             | High            | Retention team notification          |
| **Cancellation intent detected**                 | Critical        | Immediate retention workflow trigger |
| **Usage decline + support increase**             | Medium          | Proactive engagement                 |

**Churn risk score:** Composite 0-100 score computed per customer, updated after each interaction. Stored in MongoDB (customer profile), with change events emitted to ClickHouse for trend analysis. Configurable alert thresholds per customer tier.

#### Risk Score Monitoring

Unified risk dashboard combining multiple risk signals:

| Risk Category        | Components                                                           | Refresh          |
| -------------------- | -------------------------------------------------------------------- | ---------------- |
| **Operational risk** | Error rate, latency P99, provider availability                       | Real-time        |
| **Quality risk**     | Quality score trend, hallucination rate, guardrail bypass rate       | Hourly           |
| **Compliance risk**  | PII exposure events, policy violations, audit trail gaps             | Real-time        |
| **Customer risk**    | Churn probability, CSAT decline, escalation trend                    | Per-conversation |
| **Cost risk**        | Token spend rate vs budget, cost per conversation trend              | Hourly           |
| **Security risk**    | Jailbreak attempts, prompt injection rate, anomalous access patterns | Real-time        |

**Composite risk score:** Per-tenant and per-project, weighted by severity. Displayed on operational dashboard with trend arrows and drill-down capability.

---

## 12. Tier 7: Analytics Data Platform & APIs

### 12.1 Dashboards & Reports

**Pre-built (out of box):** Operational Overview, Agent Performance, Conversation Quality, Containment & Resolution, Cost & Usage, Project Summary, Voice Performance

**Custom builder:** Drag-and-drop widgets, chart library (line, bar, pie, funnel, Sankey, heatmap), metric selection (platform + custom events), dimension filtering, aggregation options, scheduling, RBAC.

**AI-powered (ThoughtSpot/Power BI Copilot):** NL queries ("show bill payment completion by amount bucket, last 30 days"), auto chart type, insight surfacing.

**Drill-down investigation tools:**

| Capability                           | Description                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| **Metric → conversation drill-down** | Click any metric data point to see the underlying conversations                    |
| **Conversation → trace drill-down**  | Open any conversation to see full agent/LLM/tool trace tree                        |
| **Trace → span detail**              | Inspect any span: LLM prompt/response, tool params/results, timing                 |
| **Funnel drill-down**                | Click any funnel stage to see conversations that dropped off at that point         |
| **Anomaly drill-down**               | From alert → triggering metric → contributing conversations → root cause traces    |
| **Cohort drill-down**                | Select any cohort segment to explore its conversations and metrics                 |
| **Cross-reference**                  | From any conversation, see: related escalations, events emitted, evaluations, tags |

**Navigation pattern:** Every metric, chart data point, and table row is clickable. Progressive disclosure from aggregate → segment → individual conversation → trace spans. Breadcrumb navigation for returning to higher levels.

### 12.2 Analytics APIs

```
GET /api/analytics/metrics?metric=containment_rate&groupBy=agent&timeRange=last_7d
GET /api/analytics/conversations?filter[quality_score_lt]=3&filter[sentiment]=negative
GET /api/analytics/events?eventType=payment_completed&filter[amount_gt]=5000
GET /api/analytics/agents/:agentId/performance?includeQualitative=true
POST /api/analytics/query  { metrics, dimensions, filters, orderBy, limit }
```

### 12.3 Data Export & Integration

| Method           | Use Case                                   |
| ---------------- | ------------------------------------------ |
| Scheduled export | CSV/Parquet to S3/GCS/Azure Blob           |
| Streaming        | Webhooks, Kafka, Redis Streams             |
| Direct warehouse | ClickHouse query access for BI tools       |
| BI connectors    | Tableau, Power BI, Looker (JDBC/ODBC/REST) |
| API pull         | REST with pagination                       |

### 12.4 Report Templates

Executive Summary (weekly, C-Suite), Operational Health (daily, ops), Agent Performance (daily, AI team), Quality Analysis (weekly, QA), Cost & ROI (monthly, finance), Improvement Progress (sprint, product), Compliance Audit (monthly, legal), Voice Performance (daily, voice ops), Custom Business Report (configurable).

### 12.5 Conversational Analytics Interface

A natural language interface for querying analytics data -- enabling non-technical users to ask questions of their agent performance, conversation quality, and business metrics data without SQL or dashboard-building skills.

**Market context:** Gartner predicts 90% of analytics content consumers will become content creators enabled by AI by 2026. The augmented analytics market is projected to grow from $15.26B (2025) to $87B (2032). ThoughtSpot Sage reports 70%+ active user adoption of NL analytics. No LLM observability platform currently offers a full NL analytics interface -- this is a clear market gap.

#### Architecture

```
User Question (NL)
    |
    v
+---------------------------+
| Query Understanding       |
| - Intent classification   |
| - Entity extraction       |
| - Ambiguity detection     |
+---------------------------+
    |
    v
+---------------------------+     +---------------------------+
| Semantic Layer             |<--->| Metric Definitions        |
| - Business concept mapping |     | - "containment rate" =    |
| - Table/column resolution  |     |   contained / total * 100 |
| - Relationship encoding    |     | - Verified example queries|
| - Temporal interpretation  |     | - Disambiguation rules    |
+---------------------------+     +---------------------------+
    |
    v
+---------------------------+
| Query Generation          |
| - Text-to-ClickHouse SQL  |
| - Mandatory tenant_id     |
| - Query validation        |
| - Explain plan check      |
+---------------------------+
    |
    v
+---------------------------+
| Execution & Rendering     |
| - Execute validated query |
| - Auto-select chart type  |
| - Generate NL summary     |
| - Suggest follow-ups      |
+---------------------------+
```

**Core architecture pattern:** Semantic Layer + Text-to-SQL + Agentic Decomposition (the industry-converging hybrid). Research shows semantic layers reduce LLM hallucinations by >50% and achieve accuracy approaching 99.8% in enterprise deployments (Snowflake Cortex Analyst benchmarks).

#### Semantic Layer (Non-Negotiable Foundation)

The semantic layer maps business vocabulary to ClickHouse schema, providing the LLM with grounding context:

```yaml
# Example semantic layer definition (YAML)
metrics:
  containment_rate:
    display_name: 'Containment Rate'
    description: 'Percentage of conversations fully resolved by AI without human escalation'
    formula: 'countIf(containment = 1) / count() * 100'
    table: conversations
    unit: percent
    dimensions: [agent_name, primary_intent, channel, project_id]
    time_grain: [hour, day, week, month]
    synonyms: ['self-service rate', 'automation rate', 'AI resolution rate']

  escalation_rate:
    display_name: 'Escalation Rate'
    description: 'Percentage of conversations transferred to human agents'
    formula: "countIf(outcome IN ('escalated_proactive', 'escalated_user', 'escalated_preemptive')) / count() * 100"
    table: conversations
    unit: percent
    inverse_of: containment_rate

  avg_quality_score:
    display_name: 'Average Quality Score'
    description: 'Mean quality score from LLM-as-judge evaluation (1-5 scale)'
    formula: 'avg(quality_score)'
    table: conversations
    unit: score_1_5

  dropoff_rate:
    display_name: 'Drop-off Rate'
    description: 'Percentage of conversations where user abandoned without resolution'
    formula: "countIf(outcome IN ('abandoned', 'stalled')) / count() * 100"
    table: conversations

dimensions:
  agent_name:
    display_name: 'Agent'
    table: agent_invocations
    column: agent_name

  primary_intent:
    display_name: 'Intent'
    table: conversations
    column: primary_intent
    synonyms: ['topic', 'reason', 'issue type']

temporal_rules:
  'last week': 'toDate(start_time) >= today() - 7'
  'this month': 'toYYYYMM(start_time) = toYYYYMM(now())'
  'yesterday': 'toDate(start_time) = today() - 1'
  'last 30 days': 'start_time >= now() - INTERVAL 30 DAY'
```

Semantic layer definitions are tenant-scoped (stored in MongoDB), extended with customer-defined metrics from their custom events.

#### Key Capabilities

| Capability                        | Description                                      | Example                                                                                       |
| --------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Natural language query**        | Type questions in plain English                  | "What's the containment rate for billing intents this week?"                                  |
| **Follow-up questions**           | Multi-turn with context retention                | "Now break that down by agent" → "Which one improved most?"                                   |
| **Visualization auto-generation** | Auto-select chart type based on data shape       | Time series → line chart, comparison → bar, distribution → histogram                          |
| **NL summaries**                  | Plain-language narrative alongside charts        | "Containment rate is 62%, down 4% from last week, driven by a decline in BillingAgent"        |
| **Proactive insights**            | Surface anomalies and trends without being asked | "Escalation rate for ReturnAgent spiked 35% in the last 2 hours"                              |
| **Suggested questions**           | Context-aware query suggestions                  | After viewing agent metrics: "Compare top 3 agents by quality score"                          |
| **Drill-down via conversation**   | Progressively narrow focus                       | "Show me by region" → "Drill into APAC" → "What's driving the decline?"                       |
| **Ambiguity resolution**          | Clarify when question is unclear                 | "Did you mean gross revenue or net revenue?" / "Which agent -- BillingAgent or PaymentAgent?" |
| **Show your work**                | Transparency into generated query                | Display generated SQL, metric definitions used, data sources queried                          |

#### Example Queries Mapped to Platform Data

| User Question                                                       | Data Source                                                 | Query Pattern                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "Are customers expressing frustration during any of the tasks?"     | conversations (sentiment), messages (per-turn sentiment)    | Sentiment analysis + topic/intent grouping                                                                    |
| "Is AgentX resulting in dropoffs at point X?"                       | conversations + agent_invocations (funnel)                  | Funnel analysis: agent → step → outcome, filter for abandoned/stalled                                         |
| "How many customers complete order booking within first 2 minutes?" | conversations (duration), platform_events (booking events)  | Time-gated event counting: events WHERE timestamp - session_start < 120s                                      |
| "Show me top 5 agents with declining quality scores this week"      | agent_invocations (quality_scores), mv_hourly_agent_metrics | Trend analysis: this week vs prior week, ranked by decline magnitude                                          |
| "What's causing the spike in escalations for billing intents?"      | escalations + conversations + agent_invocations             | Anomaly decomposition: escalation spike → trigger type distribution → contributing agents → root cause traces |
| "Compare voice vs chat containment rates this month"                | conversations (channel + containment)                       | Channel-segmented aggregation                                                                                 |

#### Agentic Query Decomposition

For complex questions that cannot be answered with a single SQL query, an agentic pipeline decomposes and executes:

```
Complex Question: "What's causing the spike in escalations for billing intents?"

Agent 1 (Planner):
  Step 1: Detect the spike (compare current vs baseline escalation rate for billing)
  Step 2: Break down escalation triggers (confidence, sentiment, loop, explicit, etc.)
  Step 3: Identify contributing agents
  Step 4: Find common patterns in escalated conversations
  Step 5: Summarize root cause

Agent 2 (Executor):
  Step 1: SELECT ... FROM escalations WHERE primary_intent LIKE '%billing%'
          AND timestamp > now() - INTERVAL 24 HOUR
  Step 2: GROUP BY trigger_type → confidence collapse is 60% of escalations
  Step 3: GROUP BY from_agent → BillingAgent accounts for 80%
  Step 4: Sample 10 conversations → tool execution failures for payment API
  Step 5: Generate summary

Agent 3 (Validator):
  - Verify SQL correctness, tenant isolation, result coherence
  - Flag if results seem implausible
```

#### Multi-Tenant Security for NL Queries

| Concern                         | Enforcement                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Tenant data isolation**       | Generated SQL always includes `WHERE tenant_id = ?` injected at execution layer (not reliant on LLM) |
| **Query validation**            | Parse and validate generated SQL before execution; reject if tenant_id filter missing                |
| **Column/table access control** | Semantic layer restricts which tables/columns are queryable per role                                 |
| **Cost protection**             | Query complexity limits (max scan rows, max joins, timeout); reject runaway queries                  |
| **Audit trail**                 | Log every NL question, generated SQL, execution result, and user identity                            |
| **Injection prevention**        | Parameterized queries; NL input sanitized before LLM processing                                      |

#### Competitive Position

| Platform                        | NL Analytics Maturity | Approach                                                                   |
| ------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| **ThoughtSpot Sage**            | Leader (BI)           | GPT + proprietary search engine, 4.5/5 rating                              |
| **Power BI Copilot**            | Leader (BI)           | Replaced Q&A with Copilot, full report generation                          |
| **BigQuery Data Canvas**        | Advanced (BI)         | Visual canvas + Gemini, Conversational Analytics API (preview)             |
| **Snowflake Cortex Analyst**    | Advanced (BI)         | YAML semantic models, multi-agent internally, ~90% SQL accuracy            |
| **Sigma Computing (Ask Sigma)** | Advanced (BI)         | Chain-of-thought transparency, MCP support                                 |
| **Observe.AI**                  | Moderate (CX)         | NL over conversation data, GenAI search                                    |
| **Cresta**                      | Moderate (CX)         | NL answers with evidence from conversations                                |
| **Langfuse**                    | Basic (LLM Obs)       | NL filtering for traces only (Sep 2025)                                    |
| **LangSmith / Arize**           | None                  | No NL analytics interface                                                  |
| **ABL Platform (target)**       | Advanced (Agent Obs)  | Semantic layer + text-to-ClickHouse + agentic decomposition + multi-tenant |

**Gap we fill:** No LLM observability or agent platform offers a full conversational analytics interface over agent performance and conversation quality data. BI platforms (ThoughtSpot, Power BI) do not understand agent-specific metrics. CX platforms (Observe.AI, Cresta) focus on human agent conversations, not AI agent analytics. ABL combines deep agent domain knowledge with NL analytics -- a unique positioning.

### 12.6 Conversation Search & Discovery

Full-text and semantic search across conversation data:

| Search Mode            | Description                                                                 | Implementation                                 |
| ---------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| **Keyword search**     | Search transcripts for specific terms                                       | ClickHouse full-text index on message content  |
| **Semantic search**    | Find conversations by meaning, not exact words                              | Embedding similarity on conversation summaries |
| **Structured filters** | Filter by outcome, agent, intent, tags, date, score ranges                  | ClickHouse WHERE clauses                       |
| **Combined**           | "Frustrated customers discussing refunds last week" = semantic + structured | NL → structured filter decomposition           |
| **Saved searches**     | Save and share frequent search queries                                      | MongoDB, tenant-scoped                         |

**Search accuracy metrics:**

- **Precision@K:** % of top-K results that are relevant (target: >85%)
- **Recall:** % of relevant conversations found (target: >90%)
- **Mean Reciprocal Rank:** Rank of first relevant result (target: >0.8)
- **Search latency:** <500ms for keyword, <2s for semantic (targets)

### 12.7 Conversation Audit Trails

Complete, tamper-evident audit trail for every conversation and administrative action:

| Audit Event                    | What's Logged                                                     | Retention              |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------- |
| **Conversation lifecycle**     | Start, each message, tool calls, handoffs, escalation, resolution | 2 years (configurable) |
| **Data access**                | Who viewed which conversation, when, from where                   | 2 years                |
| **Evaluation events**          | Evaluator invoked, scores assigned, reasoning                     | 2 years                |
| **Tag/classification changes** | Manual tag additions/removals, auto-tag results                   | 2 years                |
| **Alert lifecycle**            | Alert triggered, acknowledged, resolved, by whom                  | 1 year                 |
| **Configuration changes**      | Alert rules, evaluation criteria, topic taxonomy changes          | Indefinite             |
| **Export events**              | Data exports, API queries, BI tool connections                    | 2 years                |

**Compliance alignment:** SOC 2 Type II (audit logging), GDPR Article 30 (records of processing), EU AI Act (AI system audit trails), PCI DSS (access logging).

**Implementation:** Append-only ClickHouse `audit_trail` table with hash chains for tamper detection. Every entry includes: `tenant_id`, `actor_id`, `actor_type` (user/system/api), `action`, `resource_type`, `resource_id`, `details` (JSON), `timestamp`, `previous_hash`.

### 12.8 Regional Analytics & Localization

Support for multi-region deployments and locale-specific analytics:

| Capability                      | Description                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| **Data residency**              | ClickHouse cluster per region; data stays in region of origin                           |
| **Timezone-aware aggregation**  | All dashboards render in user's local timezone; storage in UTC                          |
| **Locale-specific formatting**  | Numbers, dates, currencies formatted per user locale                                    |
| **Language-specific sentiment** | Sentiment models calibrated per language/locale                                         |
| **Regional benchmarking**       | Compare metrics across regions (same tenant, different geographies)                     |
| **Regulatory overlays**         | Region-specific compliance rules (GDPR for EU, CCPA for California, PDPA for Singapore) |
| **Cross-region rollup**         | Global dashboards aggregate across regions with appropriate latency                     |

**Implementation pattern:** Regional ClickHouse instances with cross-region materialized views for global aggregation. Tenant configuration specifies primary region. Analytics queries route to regional cluster by default, cross-region on explicit request.

---

## 13. Competitive Landscape

### 13.1 LLM Observability Feature Matrix

| Feature        | Arize      | Arthur       | Fiddler        | LangSmith         | Braintrust   | Datadog    | Langfuse   |
| -------------- | ---------- | ------------ | -------------- | ----------------- | ------------ | ---------- | ---------- |
| OTel tracing   | Best       | No           | No             | No                | No           | Yes        | Yes        |
| LLM-as-judge   | Yes        | Yes          | Yes            | Yes               | Yes          | Yes        | Yes        |
| Custom events  | Yes        | Yes          | FQL            | Custom evals      | Scorers      | Yes        | Scores API |
| AI insights    | Copilot    | Drift        | Auto RCA       | Insights Agent    | Auto metrics | ML anomaly | --         |
| Guardrails     | No         | Best         | Yes            | No                | No           | Yes        | --         |
| Feedback loop  | Annotation | Monitor      | Eval           | Annotation queues | Best         | Alerts     | External   |
| Explainability | Drift      | Feature imp. | Shapley (best) | No                | No           | No         | --         |
| Open source    | Apache     | OSS          | No             | No                | Partial      | No         | MIT        |

### 13.2 Enterprise CS Feature Matrix

| Feature            | ServiceNow    | Salesforce   | Google CCAI   | Amazon Connect   | Microsoft D365  | Zendesk           | Intercom            |
| ------------------ | ------------- | ------------ | ------------- | ---------------- | --------------- | ----------------- | ------------------- |
| Containment        | Primary       | Yes          | Implicit      | Via categories   | Yes             | Primary           | Yes                 |
| Tracing            | Topic flow    | Full chain   | Conversation  | Transcript       | Copilot logs    | No                | No                  |
| 100% quality       | No            | Yes          | Best          | Yes              | No              | No                | CX Score            |
| Topic discovery    | Topics        | Clustering   | ML (best)     | Keywords         | No              | Intents           | Sources             |
| AI optimization    | Hints         | Flagging     | Scorecards    | Coaching         | Impact compare  | Triage            | Gap analysis (best) |
| Custom dashboards  | PA widgets    | Tableau      | BigQuery      | Configurable     | Power BI (best) | Explore           | Reports             |
| API access         | PA API        | Data 360     | REST+BigQuery | Best (V2 API)    | Dataverse       | Export            | Conv API            |
| Cost/ROI           | Time saved    | Cost savings | No            | No               | With/without AI | Cost/resolution   | Resolution          |
| Voice support      | Virtual Agent | Voice AI     | CCAI (native) | Contact Lens     | D365 Voice      | Talk              | Phone               |
| Struggle detection | No            | Predictive   | No            | Speech analytics | No              | Session analytics | Friction            |

### 13.3 Enterprise Buyer Expectations

**Table stakes:** Containment/deflection tracking, resolution rate, escalation with drill-down, CSAT, 5-10 pre-built dashboards, basic alerting.

**Differentiators:** Full reasoning traces (Salesforce), 100% AI quality eval (Google/Amazon), cost per resolution / ROI (Microsoft), AI optimization suggestions (Intercom), custom business events (Fiddler FQL), A/B AI impact comparison (Microsoft).

**Emerging (2026+):** Outcome-based metrics, hallucination tracking, helpfulness scoring, struggling user detection, real-time intervention, **conversational analytics interfaces (NL queries over agent data)**, automated agent improvement, voice-specific analytics, benchmark calibration, predictive analytics (churn risk, outcome prediction), conversation summarization.

### 13.4 Academic Evaluation Frameworks

| Category         | Key Metrics                                     | Method                   |
| ---------------- | ----------------------------------------------- | ------------------------ |
| Lexical Quality  | BLEU, ROUGE, METEOR                             | Reference comparison     |
| Semantic Quality | BERTScore, MoverScore, BLEURT                   | Embedding comparison     |
| Faithfulness     | FActScore, RAGAS                                | Claim extraction + NLI   |
| Hallucination    | SelfCheckGPT, HHEM                              | Consistency / NLI        |
| Task Success     | Pass@k, exact match, TCR                        | Programmatic             |
| Tool Use         | Selection, parameter, sequence accuracy         | Berkeley FCL             |
| Safety           | Toxicity, jailbreak resistance, PII leakage     | Classifier + red-team    |
| Agent            | Plan quality, step efficiency, handoff accuracy | LLM judge + programmatic |
| Reliability      | Consistency, calibration (ECE), robustness      | Statistical analysis     |

**Key references:** Zheng et al. 2023 (LLM-as-Judge, ~80% human correlation), Ji et al. 2023 (hallucination taxonomy), DSPy/TextGrad (prompt optimization), SWE-bench/WebArena/AgentBench (agent benchmarks), OTel GenAI conventions.

---

## 14. Benchmark Calibration & Metric Maturity

### 14.1 Baseline Establishment

New deployments need a **warm-up period** before meaningful thresholds can be set:

| Phase                     | Duration  | Activity                                                                     |
| ------------------------- | --------- | ---------------------------------------------------------------------------- |
| **Cold start**            | Week 1-2  | Collect data only. No alerts. Establish raw distributions.                   |
| **Baseline formation**    | Week 3-8  | Calculate initial baselines per metric, per intent, per agent.               |
| **Threshold calibration** | Month 2-3 | Set initial alert thresholds using statistical methods (below). Tune weekly. |
| **Steady state**          | Month 3+  | Baselines recalculated on rolling 30-day windows. Thresholds stable.         |

**Cold-start defaults** (use until data is sufficient):

| Metric              | Initial Target | Adjust When                  |
| ------------------- | -------------- | ---------------------------- |
| Containment rate    | 40%            | 500+ conversations           |
| Quality score (1-5) | 3.5            | 200+ evaluated conversations |
| WER (voice)         | 15%            | 100+ voice sessions          |
| Response latency    | 3s P95         | 1,000+ requests              |
| Escalation rate     | 35%            | 500+ conversations           |

### 14.2 Statistical Threshold Setting

**Z-score method (primary):**

```
Alert threshold = baseline_mean + Z * baseline_stddev
  Warning: Z = 2.0 (captures 95% of normal variation)
  Critical: Z = 2.5 (captures 98.7% of normal variation)
```

**Statistical Process Control (SPC) charts:**

- Upper/Lower Control Limits (UCL/LCL) at 3 sigma
- Upper/Lower Warning Limits (UWL/LWL) at 2 sigma
- Trend detection: 7+ consecutive points above/below mean (Western Electric rules)
- Out-of-control signals: 1 point beyond 3 sigma, 2/3 points beyond 2 sigma, 4/5 beyond 1 sigma

**IQR method (for non-normal distributions):**

```
Upper threshold = Q3 + 1.5 * IQR
Lower threshold = Q1 - 1.5 * IQR
```

**Per-segment baselines:** Calculate separate baselines per intent, per agent, per customer tier. A containment rate of 30% may be alarming for "check balance" but expected for "complex dispute."

### 14.3 LLM-as-Judge Calibration

LLM judges must be calibrated before their scores are trusted:

**Inter-rater reliability (required before production):**

| Metric                     | Target                          | How to Measure                               |
| -------------------------- | ------------------------------- | -------------------------------------------- |
| **Cohen's Kappa**          | >= 0.80 (substantial agreement) | LLM judge vs human expert on 200+ examples   |
| **Krippendorff's Alpha**   | >= 0.80                         | Multi-rater agreement (LLM + humans)         |
| **Spearman correlation**   | >= 0.85                         | Rank correlation on ordinal scores           |
| **Accuracy on edge cases** | >= 75%                          | Curated set of ambiguous/borderline examples |

**Known biases to mitigate:**

| Bias                      | Description                               | Mitigation                                              |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| **Position bias**         | Prefers first/last option in pairwise     | Swap order, average scores                              |
| **Verbosity bias**        | Prefers longer responses                  | Instruct judge to ignore length                         |
| **Self-enhancement bias** | Models rate own outputs higher            | Use different model family as judge                     |
| **Anchoring**             | Scores cluster around scale midpoint      | Use pairwise comparison or provide calibration examples |
| **Recency bias**          | Over-weights recent turns in conversation | Instruct to evaluate holistically                       |

**Multi-judge ensemble (recommended for production):**

- Use 2-3 different LLM judges (e.g., GPT-4o + Claude + Gemini)
- Aggregate via majority vote (categorical) or median (numeric)
- Flag disagreements for human review
- Monitor inter-judge agreement over time

**Calibration cadence:** Re-calibrate monthly against 50+ human-reviewed conversations. Track agreement drift. Alert if Kappa drops below 0.75.

### 14.4 Metric Maturity Model

Progressive rollout prevents overwhelming teams with metrics they cannot act on:

| Stage                              | Metrics                                                                                  | When               |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------ |
| **Stage 1: Core Four**             | Containment rate, escalation rate, response latency (P95), error rate                    | Day 1              |
| **Stage 2: Quality**               | Quality score (LLM-judge), helpfulness score, CSAT, cost per interaction                 | Month 1            |
| **Stage 3: Depth**                 | Tool effectiveness, comprehension failure, friction score, sentiment, hallucination rate | Month 2            |
| **Stage 4: Intelligence**          | Anomaly detection, AI optimization suggestions, drift detection, benchmark comparison    | Month 3+           |
| **Stage 5: Voice** (if applicable) | WER, MOS, TTFA, dead air, barge-in, voice containment                                    | When voice enabled |

**Unlock criteria:** Each stage unlocks when the previous stage has stable baselines (2+ weeks without threshold changes) and the team has actioned at least one insight from the current stage.

### 14.5 Alert Fatigue Prevention

| Strategy                   | Implementation                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **Severity tiers**         | Info (log only), Warning (Slack), Critical (PagerDuty), Emergency (auto-remediate) |
| **Cooldown periods**       | Same alert suppressed for 30 min after first fire                                  |
| **Composite alerts**       | Alert on escalation_rate AND sentiment_decline together, not separately            |
| **Progressive thresholds** | Start lenient, tighten as baselines stabilize                                      |
| **Anomaly vs threshold**   | Use ML anomaly detection to reduce false positives from static thresholds          |
| **Alert-to-action ratio**  | Track % of alerts that result in action. Target >60%. Below 40% = too noisy.       |

### 14.6 Cross-Tenant Anonymized Benchmarking

Allow customers to compare their metrics against anonymized peer groups (Zendesk/Intercom pattern):

**Privacy requirements:**

- Differential privacy: Add statistical noise to aggregates
- Minimum group size: 10+ tenants per benchmark cohort
- No individual tenant data exposed -- only percentile bands (P25, P50, P75, P90)
- Opt-in only

**Benchmark dimensions:**

- Industry vertical (banking, insurance, retail, etc.)
- Conversation volume tier (small, medium, large, enterprise)
- Agent complexity (single-agent, multi-agent, voice-enabled)

**Example output:** "Your containment rate (62%) is at the 65th percentile among similar-volume retail deployments. The top quartile achieves 72%+."

---

## 15. Recommended Feature Roadmap

### Phase 1: Foundation

| Feature                                                  | Priority | Effort |
| -------------------------------------------------------- | -------- | ------ |
| OTel-native tracing (session -> agent -> LLM/tool spans) | P0       | High   |
| Latency tracking (P50/P95/P99), TTFT                     | P0       | Medium |
| Token usage & cost attribution                           | P0       | Medium |
| Error rate tracking, system health                       | P0       | Medium |
| Real-time operational dashboard                          | P0       | Medium |
| Containment + escalation rate tracking                   | P0       | Medium |
| Basic alerting (threshold-based)                         | P1       | Medium |
| 5 pre-built dashboards                                   | P1       | Medium |

### Phase 2: Quality & Agent Performance

| Feature                                                                | Priority | Effort |
| ---------------------------------------------------------------------- | -------- | ------ |
| Individual agent metrics (invocations, steps, tools, costs)            | P0       | Medium |
| LLM-as-judge quality evaluation (100% coverage)                        | P0       | High   |
| Tool usage effectiveness (selection, params, retry, efficiency)        | P0       | Medium |
| Helpfulness scoring (information gain, task progression, wasted turns) | P0       | High   |
| Comprehension failure detection (fallback, rephrasing, circular)       | P0       | Medium |
| Sentiment analysis & progression                                       | P1       | Medium |
| Multi-turn memory & consistency tracking                               | P1       | Medium |
| RAG / knowledge retrieval metrics                                      | P1       | High   |
| Conversation flow analysis & drop-off funnels                          | P1       | High   |
| Multi-agent coordination metrics                                       | P1       | Medium |
| Voice metrics (WER, MOS, TTFA, dead air, barge-in)                     | P1       | High   |
| Reasoning quality metrics (coherence, calibration)                     | P2       | High   |
| Hallucination & accuracy tracking                                      | P2       | High   |
| Guardrail effectiveness (FP/FN rates)                                  | P2       | Medium |

### Phase 3: Custom Events & Business Analytics

| Feature                                                              | Priority | Effort |
| -------------------------------------------------------------------- | -------- | ------ |
| Inline event emission SDK (`context.analytics.emit()`)               | P0       | Medium |
| ABL DSL declarative event emission (`emit` blocks)                   | P0       | High   |
| Unified event model + event schema governance                        | P0       | Medium |
| Granular outcome classification (10 categories)                      | P0       | Medium |
| Human-AI collaboration metrics (handoff quality, blended resolution) | P0       | Medium |
| ROI & cost tracking dashboard                                        | P1       | Medium |
| Synchronous guardrail events                                         | P1       | High   |
| Analytics REST API                                                   | P1       | High   |
| Data export (S3, warehouse, BI tools)                                | P1       | High   |
| Customer cohort analysis                                             | P2       | High   |
| A/B testing framework                                                | P2       | High   |

### Phase 3.5: Async AI Evaluation Pipeline

| Feature                                                               | Priority | Effort |
| --------------------------------------------------------------------- | -------- | ------ |
| Async evaluation dispatcher (event bus -> evaluator fan-out)          | P0       | High   |
| LLM-as-judge custom evaluator definitions (no-code/low-code/pro-code) | P0       | High   |
| ABL DSL declarative evaluation criteria                               | P0       | High   |
| Configurable sampling strategies                                      | P1       | Medium |
| Code-based scorer functions                                           | P1       | Medium |
| Evaluation-triggered alerting                                         | P1       | Medium |

### Phase 4: AI-Powered Intelligence

| Feature                                                                | Priority | Effort    |
| ---------------------------------------------------------------------- | -------- | --------- |
| Benchmark calibration (baseline establishment, statistical thresholds) | P0       | Medium    |
| LLM-as-judge calibration (inter-rater reliability, bias mitigation)    | P0       | High      |
| Metric maturity model (progressive rollout)                            | P0       | Medium    |
| Real-time intervention triggers (struggling user detection)            | P0       | High      |
| AI optimization suggestions (Intercom gap analysis pattern)            | P0       | Very High |
| Conversation summarization (async, per-conversation)                   | P0       | Medium    |
| Conversation tagging & classification rules engine                     | P1       | High      |
| Custom topic taxonomy builder                                          | P1       | Medium    |
| ML-based anomaly detection                                             | P1       | High      |
| AI root cause analysis                                                 | P1       | High      |
| Model/provider drift detection                                         | P1       | High      |
| Automated eval -> improve cycle                                        | P1       | Very High |
| User struggle & friction scoring (composite formula)                   | P1       | Medium    |
| Conversation outcome prediction (real-time)                            | P1       | High      |
| CSAT prediction (AI-inferred, survey-free)                             | P1       | High      |
| Churn risk scoring from conversations                                  | P2       | High      |
| Risk score monitoring (unified dashboard)                              | P1       | Medium    |
| Cross-tenant anonymized benchmarking                                   | P2       | High      |
| Custom dashboard builder                                               | P1       | High      |
| Semantic drift detection                                               | P2       | High      |

### Phase 5: Advanced Platform & Conversational Analytics

| Feature                                                         | Priority | Effort    |
| --------------------------------------------------------------- | -------- | --------- |
| Conversational analytics interface (semantic layer + NL-to-SQL) | P0       | Very High |
| Semantic layer definition framework (metric/dimension mappings) | P0       | High      |
| Follow-up questions with context retention                      | P1       | High      |
| Agentic query decomposition for complex questions               | P1       | Very High |
| Visualization auto-generation from NL queries                   | P1       | High      |
| Proactive insight surfacing (anomalies, trends)                 | P1       | High      |
| Suggested questions (role-based, contextual)                    | P1       | Medium    |
| Conversation search & discovery (keyword + semantic)            | P1       | High      |
| Conversation audit trails (compliance-ready, tamper-evident)    | P1       | High      |
| Custom report builder with scheduling                           | P1       | High      |
| Regional analytics & data residency                             | P2       | Very High |
| BI tool connectors (Tableau, Power BI, Looker)                  | P2       | Medium    |
| Streaming analytics (webhooks, Kafka)                           | P2       | High      |
| Agent def semantic versioning + improvement tracking            | P2       | High      |
| Protected releases with eval gates                              | P2       | High      |

---

# PART III: NON-FUNCTIONAL REQUIREMENTS

---

## 16. Non-Functional Requirements

### 16.1 Performance & Latency

| Operation                                 | Target | Maximum | Notes                              |
| ----------------------------------------- | ------ | ------- | ---------------------------------- |
| Real-time dashboard refresh               | <1s    | 3s      | Pre-aggregated materialized views  |
| Metrics query (simple)                    | <500ms | 2s      | Single-table aggregation           |
| Metrics query (complex, multi-dimension)  | <2s    | 5s      | Multi-table joins                  |
| Event ingestion (emit to analytics store) | <5s    | 15s     | Buffered batch writes              |
| Evaluation completion (code scorer)       | <30s   | 60s     | Immediate execution                |
| Evaluation completion (LLM judge)         | <60s   | 120s    | LLM inference + parsing            |
| Alert detection to notification           | <60s   | 180s    | Including cooldown check           |
| NL query (simple, cached)                 | <2s    | 5s      | Semantic layer lookup + cached SQL |
| NL query (complex, agentic)               | <10s   | 30s     | Multi-step decomposition           |
| Conversation search (keyword)             | <500ms | 2s      | ClickHouse full-text index         |
| Conversation search (semantic)            | <2s    | 5s      | Embedding similarity               |
| Conversation summarization                | <15s   | 30s     | Async, non-blocking                |
| Data export job initiation                | <10s   | 30s     | Job queued, not completed          |

### 16.2 Scalability & Throughput

| Metric                                | Initial Target | Scale Target  | Scaling Strategy                                 |
| ------------------------------------- | -------------- | ------------- | ------------------------------------------------ |
| Events ingested/sec                   | 10K            | 100K          | Redis Streams -> Kafka at 50K+                   |
| Concurrent dashboard users per tenant | 100            | 500           | Query caching, materialized views, read replicas |
| Analytics store insert rate           | 50K rows/sec   | 200K rows/sec | Buffered batch inserts, horizontal sharding      |
| Evaluation throughput                 | 1K/min         | 10K/min       | Horizontal worker scaling                        |
| API queries/sec                       | 500            | 2,000         | Read replicas, query caching                     |
| NL query concurrency per tenant       | 10             | 50            | Query queuing, result caching                    |

### 16.3 Data Retention & Storage

| Data Type                    | Per 10K Conv/Day | Per 100K Conv/Day | Default Retention |
| ---------------------------- | ---------------- | ----------------- | ----------------- |
| Conversations                | ~5 MB/day        | ~50 MB/day        | 2 years           |
| Messages                     | ~50 MB/day       | ~500 MB/day       | 90 days           |
| Traces/spans                 | ~200 MB/day      | ~2 GB/day         | 90 days           |
| Platform events              | ~20 MB/day       | ~200 MB/day       | 2 years           |
| Evaluations                  | ~10 MB/day       | ~100 MB/day       | 2 years           |
| **Total (compressed ~10:1)** | **~30 MB/day**   | **~300 MB/day**   | --                |

Estimated disk for 100K conversations/day with 2-year retention: **~220 GB** (compressed).

**Retention policies:**

- Retention periods are configurable per tenant (within platform minimums)
- Data deletion cascades: deleting a conversation removes associated messages, evaluations, events, tags, summaries
- Export-before-delete option for compliance (retain in customer's own storage beyond platform retention)
- Audit trail retention is indefinite for configuration changes, 2 years minimum for data access events

### 16.4 Security & Tenant Isolation

| Requirement               | Implementation Approach                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tenant data isolation** | Every analytics query includes mandatory `tenant_id` filter enforced at the execution layer (not application code). Analytics store indexes optimized for tenant-first filtering. |
| **NL query isolation**    | Generated SQL validated for tenant filter presence before execution. LLM-generated queries never trusted for isolation -- filter injected deterministically.                      |
| **Encryption at rest**    | All PII in analytics store encrypted. Sensitive fields (conversation content, tool parameters) use field-level encryption with tenant-scoped keys.                                |
| **Encryption in transit** | All inter-service communication over TLS. API endpoints require HTTPS.                                                                                                            |
| **Access control**        | RBAC on all analytics endpoints. Configurable per role: which metrics, conversations, and configuration are accessible.                                                           |
| **API authentication**    | JWT-based with tenant context. SDK session tokens for programmatic access. API keys for BI tool integrations.                                                                     |
| **NL query security**     | Column/table access control via semantic layer. Query complexity limits prevent resource exhaustion. Input sanitization before LLM processing.                                    |
| **Audit logging**         | Every data access, configuration change, export, and NL query logged with actor identity, timestamp, and action detail. Tamper-evident via hash chains.                           |
| **Secret management**     | No API keys, tokens, or connection strings in source code. Environment variables or secrets provider for all credentials.                                                         |
| **SSRF protection**       | Outbound HTTP from tool execution blocks private IP ranges and metadata endpoints.                                                                                                |

### 16.5 Compliance

| Regulation                    | Requirement            | How Analytics Addresses It                                                                                                                           |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GDPR**                      | Right to erasure       | Conversation deletion cascades to all associated data (messages, traces, evaluations, events, tags, summaries). No orphaned PII.                     |
| **GDPR**                      | Data minimization      | Configurable retention with automatic expiry (TTL). Message content retained 90 days by default. PII fields encrypted at rest.                       |
| **GDPR**                      | Records of processing  | Audit trail logs all data access and processing activities.                                                                                          |
| **SOC 2 Type II**             | Audit logging          | Comprehensive audit trail with tamper detection (hash chains). All administrative actions logged.                                                    |
| **SOC 2 Type II**             | Access controls        | RBAC on all endpoints. Permission checks enforced centrally.                                                                                         |
| **EU AI Act**                 | AI system traceability | Full trace from user query through agent reasoning to tool execution and response. Every LLM call and evaluation recorded with model, input, output. |
| **EU AI Act**                 | Risk management        | Risk score monitoring across operational, quality, compliance, customer, and security dimensions.                                                    |
| **PCI DSS**                   | Access logging         | Data access audit trail with actor identity and timestamp.                                                                                           |
| **PCI DSS**                   | Encryption             | Field-level encryption for sensitive data. Tenant-scoped encryption keys.                                                                            |
| **Cross-tenant benchmarking** | Differential privacy   | Anonymized aggregates only. Minimum 10 tenants per cohort. Statistical noise added. Opt-in only.                                                     |

### 16.6 Availability & Reliability

| Requirement                    | Target                                                  |
| ------------------------------ | ------------------------------------------------------- |
| Analytics dashboard uptime     | 99.9% (excludes planned maintenance)                    |
| Event ingestion availability   | 99.95% (no data loss during ingestion)                  |
| Data durability                | 99.999% (analytics store replication)                   |
| Alert delivery                 | 99.9% (with retry and dead-letter queue)                |
| Recovery Time Objective (RTO)  | <1 hour for analytics queries; <4 hours for full system |
| Recovery Point Objective (RPO) | <5 minutes (event bus provides replay)                  |

**Reliability patterns:**

- Event bus provides replay capability for reprocessing after failures
- Evaluation workers use dead-letter queues with exponential backoff retry
- Idempotent writes prevent duplicate data from retries
- Per-tenant evaluation budget caps prevent cost explosions from runaway evaluations
- Circuit breakers on external LLM calls with fallback to code scorers

### 16.7 Observability & Monitoring

The analytics system must itself be observable:

| What to Monitor            | Metrics                                                                | Alerting                                        |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| Ingestion pipeline health  | Events/sec ingested, lag, error rate                                   | Alert if lag > 60s or error rate > 1%           |
| Evaluation pipeline health | Evaluations/min, queue depth, failure rate                             | Alert if queue depth > 10K or failure rate > 5% |
| Analytics store health     | Query latency P95, disk usage, replication lag                         | Alert if P95 > 5s or disk > 80%                 |
| NL analytics accuracy      | User feedback (helpful/not helpful/wrong), SQL validation failure rate | Alert if "wrong" feedback > 15%                 |
| Alert engine health        | Alerts triggered/min, delivery success rate                            | Alert if delivery failure > 1%                  |
| API health                 | Request rate, error rate, latency P95                                  | Standard API monitoring                         |

---

## 17. Sources

### LLM Observability Platforms

- [Arize AI / Phoenix](https://arize.com/) | [Arize Phoenix GitHub](https://github.com/Arize-ai/phoenix)
- [Arthur AI](https://www.arthur.ai/) | [Arthur Agentic Monitoring](https://www.arthur.ai/blog/introducing-agentic-ai-monitoring-tracing-on-arthur)
- [Fiddler AI](https://www.fiddler.ai/) | [Fiddler FQL](https://docs.fiddler.ai/observability/platform/fiddler-query-language)
- [LangSmith](https://www.langchain.com/langsmith) | [Insights Agent](https://www.blog.langchain.com/insights-agent-multiturn-evals-langsmith/)
- [Braintrust](https://www.braintrust.dev) | [Online Scoring](https://www.braintrust.dev/docs/observe/score-online) | [Custom Scorers](https://www.braintrust.dev/blog/custom-scorers)
- [Datadog LLM Observability](https://www.datadoghq.com/product/llm-observability/) | [Custom LLM-as-Judge](https://docs.datadoghq.com/llm_observability/evaluations/custom_llm_as_a_judge_evaluations/)
- [Langfuse](https://langfuse.com/) | [Scores API](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk)
- [LangWatch](https://langwatch.ai/) | [Helicone](https://www.helicone.ai/) | [W&B Weave](https://wandb.ai/site/weave/)

### Enterprise Platforms

- [ServiceNow Conversational Analytics](https://www.servicenow.com/community/virtual-agent-nlu-articles/conversational-analytics-dashboard-definitions-and-retention/ta-p/2421029)
- [Salesforce Agentforce](https://www.salesforce.com/agentforce/observability/) | [Analytics](https://help.salesforce.com/s/articleView?id=ai.copilot_reports_dashboards.htm)
- [Google CCAI Insights](https://cloud.google.com/solutions/ccai-insights) | [Quality AI](https://docs.google.com/contact-center/insights/docs/qai-basics)
- [Amazon Connect Analytics](https://aws.amazon.com/connect/conversational-analytics/) | [GetMetricDataV2](https://docs.aws.amazon.com/connect/latest/APIReference/API_GetMetricDataV2.html)
- [Microsoft D365 Copilot Analytics](https://learn.microsoft.com/en-us/dynamics365/contact-center/use/copilot-analytics-report)
- [Zendesk AI Analytics](https://support.zendesk.com/hc/en-us/articles/9510024609178) | [Explore](https://support.zendesk.com/hc/en-us/articles/4408831710618)
- [Intercom Fin Reporting](https://www.intercom.com/help/en/articles/7837533-fin-ai-agent-reporting) | [CX Score](https://www.intercom.com/help/en/articles/10495092-understand-customer-experience-at-scale-with-the-cx-score)

### Academic & Standards

- [OTel GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | [Agent Spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
- [RAGAS Framework](https://docs.ragas.io/) | [DSPy Optimizers](https://dspy.ai/learn/optimization/optimizers/)
- [Zheng et al. 2023 -- LLM-as-Judge](https://arxiv.org/abs/2306.05685) | [Ji et al. 2023 -- Hallucination](https://arxiv.org/abs/2202.03629) | [FActScore](https://arxiv.org/abs/2305.14251)
- [DeepEval Agent Metrics](https://deepeval.com/guides/guides-ai-agent-evaluation-metrics) | [Confident AI](https://www.confident-ai.com/blog/llm-agent-evaluation-complete-guide)
- [Anthropic -- Demystifying Evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | [Measuring Agent Autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)

### Conversational Analytics / NL Interfaces

- [ThoughtSpot Sage](https://docs.thoughtspot.com/cloud/10.14.0.cl/search-sage) | [Agentic Data Prep (Feb 2026)](https://www.globenewswire.com/news-release/2026/02/18/3240288/0/en/ThoughtSpot-Launches-Agentic-Data-Prep.html)
- [Power BI Copilot](https://learn.microsoft.com/en-us/power-bi/create-reports/copilot-introduction) | [Q&A Deprecation (Dec 2026)](https://www.magnetismsolutions.com/news/power-bi-qampa-to-retire-by-december-2026)
- [Google BigQuery Data Canvas](https://docs.cloud.google.com/bigquery/docs/data-canvas) | [Conversational Analytics API](https://docs.cloud.google.com/gemini/docs/conversational-analytics-api/overview)
- [Snowflake Cortex Analyst](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst) | [Agentic Semantic Model](https://www.snowflake.com/en/engineering-blog/agentic-semantic-model-text-to-sql/)
- [Sigma Computing Ask Sigma](https://www.sigmacomputing.com/product/ask-sigma) | [Databricks Genie + Assistant](https://www.databricks.com/product/databricks-assistant)
- [Wren AI (Open Source GenBI)](https://www.getwren.ai/oss) | [Semantic Layer for Text-to-SQL](https://www.getwren.ai/post/why-the-semantic-layer-is-essential-for-reliable-text-to-sql)
- [Langfuse NL Filtering for Traces (Sep 2025)](https://langfuse.com/changelog/2025-09-30-natural-language-filters)
- [Observe.AI Conversational Intelligence](https://www.observe.ai/platform/conversational-intelligence)
- [Cresta Conversation Intelligence](https://cresta.com/conversation-intelligence)
- [Google Cloud Text-to-SQL Techniques](https://cloud.google.com/blog/products/databases/techniques-for-improving-text-to-sql)
- [Agentic Analytics Guide -- GoodData](https://www.gooddata.com/blog/agentic-analytics-complete-guide-to-ai-driven-data-intelligence/)
- [Gartner: 75% Analytics Content via GenAI by 2027](https://www.gartner.com/en/newsroom/press-releases/2025-06-18-gartner-predicts-75-percent-of-analytics-content-to-use-genai)
- [Conversational AI Market ($14.79B → $82.46B)](https://www.fortunebusinessinsights.com/conversational-ai-market-109850)
- [Augmented Analytics Market ($15.26B → $87B)](https://www.marketsandmarkets.com/Market-Reports/conversational-ai-market-49043506.html)

### Industry Reports & Market Research

- [LangChain State of Agent Engineering (2025)](https://www.langchain.com/stateofaiagents)
- [Business Research Company -- LLM Observability Market](https://www.thebusinessresearchcompany.com/)
- [EU AI Act Timeline](https://artificialintelligenceact.eu/) | [Gartner AI TRiSM](https://www.gartner.com/en/articles/ai-trism)
- [AWS -- Evaluating AI Agents](https://aws.amazon.com/blogs/machine-learning/evaluating-ai-agents-real-world-lessons-from-building-agentic-systems-at-amazon/)
- [IBM AI Agent Evaluation](https://www.ibm.com/think/tutorials/ai-agent-evaluation)
- [Microsoft D365 AI Agent Performance](https://www.microsoft.com/en-us/dynamics-365/blog/it-professional/2026/02/04/ai-agent-performance-measurement/)
- [Galileo AI Agent Metrics](https://galileo.ai/blog/ai-agent-metrics)

### Custom Events & Evaluation Patterns

- [Segment Naming Conventions](https://segment.com/academy/collecting-data/naming-conventions-for-clean-data/)
- [Amplitude Taxonomy Planning](https://amplitude.com/docs/data/data-planning-playbook)
- [Event Versioning Strategies](https://theburningmonk.com/2025/04/event-versioning-strategies-for-event-driven-architectures/)

### Helpfulness, Comprehension & User Struggle

- [ChatBench -- AI Chatbot Performance Metrics (2026)](https://www.chatbench.org/what-are-the-most-important-metrics-for-assessing-ai-chatbot-performance/)
- [Nurix.ai -- Chatbot Evaluation Metrics](https://www.nurix.ai/blogs/essential-chatbot-evaluation-metrics-success)
- [Calabrio -- Chatbot Performance Metrics](https://www.calabrio.com/wfo/contact-center-ai/key-chatbot-performance-metrics/)
- [Contentsquare -- Rage Click Detection](https://contentsquare.com/guides/heatmaps/rage-click-maps/)
- [Nature Scientific Reports -- Intelligent Emotion Sensing (2025)](https://www.nature.com/articles/s41598-025-15501-y)
- [ACL 2025 -- User Frustration Detection](https://aclanthology.org/2025.coling-industry.23.pdf)
- [Kore.ai Conversation Intelligence](https://docs.kore.ai/xo/quality-ai/analyze/conversation-intelligence/)
- [ASAPP Speech Analytics](https://www.asapp.com/solutions/speech-analytics)
- [Replicant -- AI Escalation Rules](https://www.replicant.com/blog/when-to-hand-off-to-a-human-how-to-set-effective-ai-escalation-rules)
- [Everworker -- Escalation Playbook](https://everworker.ai/blog/ai_escalation_playbook_customer_support)

### Voice AI & Speech Analytics

- [Google Cloud Speech-to-Text](https://cloud.google.com/speech-to-text) | [Amazon Transcribe](https://aws.amazon.com/transcribe/)
- [Amazon Connect Contact Lens](https://aws.amazon.com/connect/contact-lens/)
- [Replicant Voice AI](https://www.replicant.com/) | [PolyAI Voice](https://poly.ai/)
- [PESQ/POLQA Voice Quality Standards](https://www.itu.int/rec/T-REC-P.863)
- [Nuance/Microsoft Voice Analytics](https://www.nuance.com/omni-channel-customer-engagement/voice-and-ivr.html)
- [Deepgram Speech Analytics](https://deepgram.com/) | [AssemblyAI](https://www.assemblyai.com/)

### Benchmark Calibration & Evaluation Standards

- [Cohen's Kappa -- Inter-Rater Reliability](https://en.wikipedia.org/wiki/Cohen%27s_kappa)
- [Krippendorff's Alpha](https://en.wikipedia.org/wiki/Krippendorff%27s_alpha)
- [Statistical Process Control Charts](https://asq.org/quality-resources/control-chart)
- [Western Electric Rules for Control Charts](https://en.wikipedia.org/wiki/Western_Electric_rules)
- [Prometheus LLM Judge (Kim et al. 2024)](https://arxiv.org/abs/2405.01535)
- [Position Bias in LLM-as-Judge (Zheng et al.)](https://arxiv.org/abs/2306.05685)
- [Zendesk Benchmarks](https://www.zendesk.com/benchmark/) | [Intercom Peer Comparison](https://www.intercom.com/help/en/articles/7837533-fin-ai-agent-reporting)

### AI-Powered Analytics

- [ThoughtSpot AI Analytics](https://www.thoughtspot.com/data-trends/ai/ai-tools-for-data-visualization)
- [Power BI Copilot](https://learn.microsoft.com/en-us/power-bi/create-reports/copilot-introduction)
- [Grafana AI Tools](https://grafana.com/products/cloud/ai-tools-for-observability/)
- [Vellum AI](https://www.vellum.ai/) | [DSPy GitHub](https://github.com/stanfordnlp/dspy)

### Drift & Reliability

- [Fiddler -- LLMOps Drift Monitoring](https://www.fiddler.ai/blog/how-to-monitor-llmops-performance-with-drift)
- [Evidently AI -- RAG Evaluation](https://www.evidentlyai.com/llm-guide/rag-evaluation)
- [Orq.ai -- Model vs Data Drift](https://orq.ai/blog/model-vs-data-drift)
- [Statsig -- Hallucination Detection](https://www.statsig.com/perspectives/hallucination-detection-metrics-methods-llms)
- [Patronus AI -- RAG Evaluation Metrics](https://www.patronus.ai/llm-testing/rag-evaluation-metrics)
