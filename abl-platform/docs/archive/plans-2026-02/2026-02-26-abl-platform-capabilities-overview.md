# ABL Platform — Capabilities Overview

> For CTO and CRO audiences at partner product companies building on the ABL Platform.

---

## 1. Agent Orchestration with ABL

### The ABL Language

ABL (Agent Blueprint Language) is a compilable, YAML-compliant domain-specific language purpose-built for defining, orchestrating, and governing AI agents. Agent definitions are plain YAML files — editable in any editor, lintable with standard tools, diffable in pull requests, and version-controlled in Git alongside your application code.

ABL uses a **Core + Extensions** architecture. A simple chatbot uses only the Core — agent identity, tools, and basic responses. As requirements grow, teams opt into extensions independently: **Gather** for structured information collection, **Constraints** for deterministic behavioral rules, **Flows** for scripted state machines, **Coordination** for multi-agent orchestration, **State Management** for typed session variables and persistent memory, **Rich Content** for multi-format output, and **Expressions** for conditional logic and computed values. The language scales with the problem — teams never encounter complexity they haven't opted into.

Compile-time validation catches broken handoff targets, invalid tool references, unreachable flow steps, malformed constraint expressions, and type mismatches before deployment — never in production. A built-in expression engine provides 30+ functions for arithmetic, string manipulation, date handling, array operations, formatting, and conditional logic.

**Python and TypeScript Builder SDKs** ship in Release 2 — enabling programmatic agent authoring in Jupyter notebooks, CI/CD pipelines, and custom orchestration frameworks.

### Complex Agent Orchestration Patterns

ABL provides five first-class coordination primitives that compose into sophisticated multi-agent systems:

**Supervisor Routing** classifies intent and routes to specialized child agents with priority rules and conditional logic based on runtime context. A default fallback handles unmatched intents. Supervisors maintain a routing table — not code — making routing changes a configuration update, not an engineering sprint.

**Delegation** invokes a sub-agent synchronously with explicit typed input/output mapping, configurable timeout, and failure handling strategies (continue, escalate, or respond). Agents can fan out to multiple sub-agents in parallel and synthesize their results into a unified response.

**Handoff** transfers full conversational control to another agent with typed context passing, configurable conversation history strategies (none, summary only, full transcript, or last N messages), memory grants, and an optional return flow back to the originating agent.

**Escalation** transfers to a human with priority levels, skill-based routing tags, PII-safe context summaries, and on-complete hooks that define what happens when the human resolves (or doesn't). The full handoff package — transcript, collected information, sentiment, actions attempted, tools called — travels with the escalation.

**A2A Federation** enables cross-platform agent communication via the Agent-to-Agent protocol. OAuth2 and webhook-based federation allows agents built on ABL to collaborate with agents running on external partner infrastructure.

These primitives compose into real-world patterns:

- **Hierarchical triage** — Supervisor classifies the request, delegates to a specialist, the specialist delegates document verification to a sub-agent, and results flow back through the entire chain with context intact at every level.
- **Parallel fan-out with synthesis** — An agent delegates the same request to three specialists simultaneously (e.g., pricing, inventory, shipping), collects all results, and presents a unified answer to the user.
- **Identity-gated access** — The engine blocks tool calls when the caller's identity verification tier is insufficient and forces an escalation path before any sensitive data is accessed. This is deterministic and auditable — not a prompt suggestion.
- **Cross-domain handoff chains** — A claims agent hands off to a billing agent, which federates with an external partner's adjuster via A2A, and the result flows back to the claims agent with full context preserved at every hop.
- **Hybrid execution in a single flow** — A scripted IVR collects an account number in sub-500ms with no LLM cost, then hands off to a reasoning agent for complex dispute resolution, which delegates document verification back to a scripted sub-agent. One system handles both deterministic and flexible execution.

### Execution Modes

Three modes coexist in the same system, same session management, and same orchestration primitives:

**Reasoning mode** — LLM-driven agent loops that plan, execute tools, observe results, and re-plan. Full tool access and flexible decision-making for complex problems like claims assessment, dispute resolution, and open-ended customer support.

**Scripted mode** — Deterministic state machines with NER-based entity extraction and explicit step transitions. Sub-500ms latency with no LLM cost per turn. Ideal for voice IVR, identity verification, payment processing, and high-volume transactional flows.

**Hybrid** — A supervisor in reasoning mode routes to a scripted agent. A scripted agent delegates back to a reasoning agent mid-flow. Teams choose the right execution mode per agent and per step — not per system.

### Structured Information Gathering

The GATHER construct collects structured data with type safety and validation guarantees. Seven field types (string, number, date, boolean, datetime, array, enum) support validation rules including pattern matching, range constraints, enum enforcement, custom business logic, and LLM-based validation. Users can naturally correct previously provided information ("actually 4 guests, not 3"). Cross-field dependencies, multiple extraction strategies (NER, LLM, hybrid), and activation strategies (required, optional, progressive, data-driven) support complex collection workflows in regulated industries.

### Declarative Constraint Enforcement

Constraints are formal behavioral rules evaluated by the deterministic engine — separate from the LLM. The LLM cannot override them. On violation, the engine takes a configured action: respond with a message, escalate to a human, hand off to another agent, block the operation, or redact sensitive content. Constraints are grouped by phase (pre-search, pre-booking, always) and produce a full audit trail showing which constraint fired, when, and why. This is provable to regulators — not probabilistic.

---

## 2. Building, Testing, Debugging & Managing Agents with AI

### Arch — The AI Solution Architect

Arch is an AI that is contextually aware of every agent, handoff, routing rule, tool binding, constraint, and escalation path in your entire project. It operates across six lifecycle stages:

**Ideate** — Describe what you need in natural language. Arch interviews you with targeted questions, extracts requirements from uploaded documents (PDFs, API specs, existing YAML configurations), and builds a structured project brief.

**Design** — Arch proposes a complete agent topology: supervisors, specialists, routing rules, escalation paths, and tool bindings. The topology renders as a live interactive graph. Arch is proactive: "There's no fallback for unmatched intents — want me to add an escalation path?" Changes happen conversationally: "Make billing a reasoning agent" — Arch updates the topology and explains the trade-offs (latency vs. flexibility, cost implications).

**Build** — Arch generates syntactically valid, compilable ABL for every agent in the topology. Changes appear as inline diffs. The platform validates in real-time — compilation errors surface immediately and Arch fixes them. Suggestion chips offer next actions: "Add error handling", "Configure escalation", "Add constraints for PCI compliance."

**Test** — Arch generates test personas (Frustrated Customer, Elderly User, Tech-Savvy Power User) and conversation scenarios. It runs automated test suites with LLM-judge evaluators and surfaces coverage gaps: "The billing agent has no cancellation test — want me to create one?"

**Deploy** — Pre-flight validation checks compilation, constraint coverage, tool endpoint reachability, evaluation coverage, escalation path completeness, and error handlers. Arch provides commentary on each check.

**Improve** — Post-deployment, Arch analyzes production conversation data and proactively suggests improvements tied to customer outcomes: "Escalation rate for billing is above threshold — here's a routing change that could reduce it by 15%." "Users are asking about international transfers and no agent handles it — want me to design one?"

Arch operates in two modes: **Assisted** (guided wizard where Arch drives the process with explanations — ideal for domain experts and solution architects) and **Pro** (direct ABL editing with Arch as a sidebar collaborator — ideal for developers who want speed and control).

### AI-Powered Agent Development with Claude Code, Cursor & MCP

The platform ships an **MCP (Model Context Protocol) Debug Server with 18 tools** that connects any MCP-compatible AI — Claude Code, Cursor, or custom integrations — directly to the running agent runtime. This transforms agent development from a UI-driven workflow into an AI-assisted engineering workflow where your AI pair programmer understands your agents as deeply as it understands your code.

**Build agents from your terminal.** Claude Code reads your ABL definitions, understands the agent topology, and generates new agents or modifies existing ones with full awareness of your project's constraints, tools, and orchestration patterns. The platform validates every change immediately — errors feed back to Claude Code, which fixes them and resubmits. The loop is tight: generate → validate → fix → deploy.

**Debug live agents without leaving your editor.** Connect to a running runtime, load any agent, send test messages, and watch exactly what happens. The 18 MCP tools provide:

- **Session interaction** — Send messages to agents, observe responses, reset sessions. Test conversation flows end-to-end from your terminal.
- **Trace analysis** — Inspect every LLM call, tool execution, decision point, constraint check, handoff, and escalation. Search traces by text, event type, agent name, or error presence. View hierarchical execution trees showing parent-child relationships and timing.
- **Decision explanation** — Ask "why did the agent make that choice?" and get a detailed explanation with the surrounding context that led to the decision.
- **State inspection** — View current context variables, gathered fields, flow step position, active constraints, and memory state at any point in a conversation.
- **Flow visualization** — Generate agent execution graphs as Mermaid diagrams or structured JSON. Visualize state machines for all three agent types (scripted, reasoning, supervisor).
- **Live observation** — List all active sessions in the runtime, subscribe to a session running in the UI, and watch its trace events stream into your editor in real-time.
- **Automated diagnostics** — Run AI-powered session analysis that reports event statistics, detects loops, tracks constraint violations, identifies tool failures, flags missing gathered fields, and surfaces performance warnings.
- **Embedded documentation** — ABL language reference is available to the AI during debugging, so it can reason about your agent definitions with full knowledge of the DSL.

**Bring Your Own AI.** The platform is model-agnostic. Beyond Arch and the MCP debug server, any frontier model (Claude, GPT, Gemini, or others) can interact with the platform via structured APIs to read and modify agent definitions, design topologies, run tests, and manage deployments. The MCP protocol is an open standard — any tool that speaks MCP can become an agent development environment.

### Git Integration & Project Management

Agent definitions are code. The platform treats them accordingly:

- **Git-native workflow** — ABL files live in your repository. Branch, review, merge, and revert agent changes with the same Git workflows your team already uses. Agent topology changes show up as readable YAML diffs in pull requests.
- **Project configuration** — Projects group agents, tools, environment variables, secrets, and deployment configurations. Per-environment settings (dev, staging, production) travel with the project.
- **Environment management** — Secrets and configuration variables are scoped per deployment environment. Sensitive values are encrypted and never stored in plaintext.
- **Immutable versioned deployments** — Every deployment is a versioned, immutable snapshot. Roll back to any previous version instantly. Environment-scoped configuration means the same agent definition deploys differently to staging and production.
- **Version comparison** — Diff any two agent versions side-by-side. Track changes over time. Promote versions across environments.
- **Project export/import** — Full project portability in ABL DSL, YAML, or JSON formats. Move entire agent systems between environments or organizations.

### Testing & Validation

- **Compile-time validation** — Structural errors are caught before deployment: broken handoff targets, invalid tool references, unreachable flow steps, type mismatches, malformed expressions. The feedback is immediate — in your editor via MCP, in Studio via Arch, and in CI/CD via the CLI.
- **Auto-generated test scenarios** — Arch generates test personas and conversation scenarios from your agent definitions. LLM-judge evaluators score test results on resolution quality, helpfulness, safety, and instruction following.
- **Mock tool execution** — Test agents deterministically by substituting real tool calls with mock responses. Validate conversation flows without calling external services.
- **CI/CD integration** — The CLI compiles, validates, and tests agents in your pipeline. Python and TypeScript SDKs (Release 2) enable programmatic agent management as part of automated workflows.

---

## 3. Data & Knowledge, Omnichannel & User Experience

### Data & Knowledge Capabilities

**80+ pre-built enterprise connectors** — SharePoint, Jira, Confluence, Salesforce, ServiceNow, Google Drive, Slack, Zendesk, and many more. An extensible connector framework supports custom data sources with reusable OAuth, rate limiting, retry, checkpoint management, and permission crawling infrastructure.

An **intelligent ingestion pipeline** processes documents through semantic chunking, noise detection and quality filtering, entity extraction, knowledge graph construction, progressive hierarchical summarization, and automatic QA pair generation. **Multimodal processing** handles documents with OCR and table detection, video with frame extraction, and audio with transcription.

**Permission-aware retrieval** combines semantic, keyword, and hybrid search strategies with document access scoped by user and tenant permissions. Citation tracking links every response to its source documents. Stale knowledge detection flags responses based on outdated information.

### Omnichannel Capabilities

**10+ channel adapters** cover web (AG-UI), WhatsApp, Slack, Microsoft Teams, SMS, voice (SIP/Jambonz, WebRTC/LiveKit, Twilio, KoreVG), email, and Facebook Messenger.

**Cross-channel session continuity** lets a customer start a conversation on web chat at work, leave, and resume hours later on WhatsApp from a personal phone — without repeating anything. The platform handles identity resolution, session rehydration, and context preservation automatically.

**Voice-native features** include W3C SSML prosody control, sub-500ms scripted mode for IVR, real-time speech-to-text and text-to-speech integration, barge-in handling, and DTMF fallback. Voice agents and chat agents share the same ABL definitions, orchestration, and constraints.

A **Web SDK** provides React components, chat UI, and voice support with public key initialization (no secrets exposed client-side) and automatic session management with 4-hour JWT tokens and refresh.

**Rich content output** spans Markdown, Adaptive Cards, HTML, Slack Block Kit, WhatsApp templates, and AG-UI custom components. Interactive elements include buttons, dropdowns, cards, carousels, and quick replies with configurable action handlers.

### User Experience Highlights

**Studio** is a full web IDE for agent development. A Monaco-based ABL editor provides syntax highlighting and real-time validation. The agent topology canvas renders interactive network graphs — supervisors, specialists, handoff paths, delegation chains, and escalation routes laid out with DAG visualization. Click any agent to see its definition, live metrics, and trace history.

**Session playback** replays any conversation with a trace timeline. Scrub through the timeline to see exactly what happened at each step — which tool was called, which constraint fired, which field was extracted, what the LLM decided and why. This is the debugging experience for non-terminal users.

A **drag-and-drop dashboard builder** supports custom analytics views with a chart library including line, bar, pie, funnel, Sankey, and heatmap visualizations. Every metric, chart data point, and table row is clickable — progressive drill-down navigates from aggregate metrics to individual conversations to trace-level detail.

A **command palette** provides quick navigation and action execution across the entire platform. Dark, light, and system themes are supported with smooth transitions.

---

## 4. Analytics, Observability & Enterprise

### Analytics & Observability

#### Operational Observability

**End-to-end tracing** captures every LLM call, tool execution, agent handoff, constraint check, escalation, and error with session identity, agent name, tenant context, timing, and caller information. Traces propagate context across multi-agent handoffs — a conversation that touches five agents produces one coherent trace tree.

**Latency tracking** at P50/P95/P99 covers end-to-end response time, time to first token per LLM call, tool execution duration, retrieval latency, and handoff queue time. Voice-specific metrics include time to first byte, time to first audio, and end-to-end voice latency.

**Token usage and cost attribution** tracks input, output, and reasoning tokens per model. Costs attribute to tenant, project, agent, intent, customer segment, and tool. Budget alerts and spend tracking identify the 5% of requests consuming 50% of token budget.

**Real-time dashboards** display active conversations, error rates (5-minute rolling), response latency, escalation rates, token spend, top intents, and provider status with live streaming updates.

**Drift detection** monitors input/output distribution shifts, prompt drift, model degradation over time, semantic entropy, provider availability, and fallback trigger rates.

#### Agent Performance Analytics

**Quantitative metrics** per agent: invocation count, step execution count, tool success rate, average steps and turns per conversation, containment and escalation rates, error rate, and average cost per invocation.

**Qualitative metrics** via LLM-as-judge evaluation: goal completion, topic adherence, instruction following, response relevance, accuracy, tonality, empathy, safety compliance, and helpfulness scoring on a 1-5 rubric.

**Tool effectiveness** metrics: selection accuracy (right tool for the task?), parameter accuracy, retry rates, call sequence accuracy for multi-tool workflows, call efficiency (actual vs. optimal tool calls), and unused tool detection.

**Multi-agent coordination** metrics: handoff accuracy and latency, context preservation score across transfers, resolution depth (agent-to-agent transitions before resolution), agent utilization distribution for bottleneck detection, and redundant work rate.

**ABL-specific extraction metrics**: accuracy of extracted values, completeness of required fields, extraction efficiency (actual vs. optimal turns to gather), and clarification rate.

#### Conversation & Quality Analytics

**100% conversation evaluation** uses LLM-as-judge to score every conversation on resolution quality, accuracy, helpfulness, coherence, professionalism, safety, and PII handling. A **composite CX score** provides an AI-generated customer experience rating per conversation — covering 100% of interactions compared to 5-15% survey response rates.

**Friction detection** identifies struggling users through behavioral signals: repeated rephrasing, increasing message length, response time anomalies, explicit frustration language, turn count outliers, repeat contacts within 24-72 hours, and channel switches. A composite friction score weights these signals for automated alerting.

**Sentiment progression** tracks turn-level sentiment for both user and agent, identifies trajectory (improving, stable, declining), and pinpoints which specific responses caused sentiment shifts. Voice channels add acoustic sentiment analysis — tone, pitch, and speaking rate — as a leading indicator that precedes linguistic frustration by 2-3 turns.

**Conversation summarization** auto-generates structured summaries: executive summary, key topics discussed, actions taken, outcome and next steps, customer sentiment arc, and risk flags.

**Safety monitoring** covers hallucination detection, guardrail effectiveness (false positive and false negative rates), prompt injection tracking, and regulatory disclosure verification.

#### Business Outcome Analytics

**Core customer service metrics**: containment rate, deflection rate, first contact resolution, average handle time, escalation rate, drop-off and abandonment, resolution accuracy, customer effort score, and repeat contact rate.

**Voice channel metrics**: word error rate, mean opinion score, barge-in detection, dead air and silence duration, turn-taking latency, voice containment rate, and conversation pacing.

**Granular outcome classification** goes beyond resolved/escalated/abandoned to 10 categories: fully resolved, partially resolved, proactive escalation (AI detected frustration), user-requested escalation, pre-emptive escalation, misdirected, stalled, abandoned, duplicate, and resolved with workaround.

**Human-AI collaboration** metrics: handoff context quality, human handle time post-escalation, human override rate, blended resolution quality, and the ratio of proactive vs. reactive escalations.

**ROI tracking**: cost per AI interaction, cost per contained vs. escalated interaction, total cost savings, and true cost per conversation (platform cost + escalation rate x agent cost + repeat rate x rework cost).

#### DSL-Native Event Emission

A **three-pattern event model** unifies all analytics signals. **Inline emission** (via SDK or ABL declarative syntax) lets developers emit custom business events from tool execution — "Payment Completed", "Policy Renewed" — with typed properties, version-controlled alongside agent definitions. **Synchronous guardrail events** emit pass/fail signals from real-time safety checks (PII detection, compliance, jailbreak prevention). **Async AI evaluation** runs LLM-as-judge scoring in the background with zero latency impact. All three patterns flow into the same analytics system via a unified event model with schema governance.

**Tiered evaluation criteria** support no-code scorecards ("Did agent verify identity?" Yes/No), low-code natural language criteria ("Rate helpfulness 1-5"), and pro-code custom scorer functions in TypeScript or Python.

#### Roadmap — AI-Powered Insights (Release 2+)

- **Anomaly detection and alerting** with configurable thresholds for containment drops, error rate spikes, escalation surges, latency degradation, and sentiment decline
- **Real-time intervention triggers** that detect struggling users mid-conversation (confidence collapse, comprehension loops, sentiment degradation) and auto-escalate before the customer explicitly asks
- **AI root cause analysis** that clusters failing traces, decomposes failures by component, and generates natural-language root cause hypotheses
- **AI optimization suggestions** targeting specific agent definitions: "Add tool binding for refund_initiation — 34 conversations failed because capability missing." "Lower escalation threshold from 8 to 5 turns — sentiment shows frustration starts at turn 5."
- **Predictive analytics** including real-time outcome prediction, AI-inferred CSAT (100% coverage without surveys, calibrated against actual survey responses), churn risk scoring from conversation signals, and resolution time estimation
- **Conversational analytics interface** enabling natural language queries over agent data ("What's the containment rate for billing intents this week?") with auto-generated visualizations, follow-up questions, and drill-down investigation
- **Risk score monitoring** combining operational, quality, compliance, customer, cost, and security risk signals into per-tenant and per-project composite scores

### Enterprise Features

#### Security & Tenant Isolation

Tenant isolation is enforced at every data path — database queries, cache keys, analytics storage, and in-memory structures are all tenant-scoped. Cross-tenant access returns 404 to prevent existence leakage.

Authentication converges three flows (user JWT, SDK session tokens, API keys) into a single identity context via shared middleware. No route or service re-implements authentication. SSO supports SAML (SP-initiated and IdP-initiated) and OIDC. Social login covers Google, LinkedIn, and Microsoft. MFA provides TOTP with recovery codes and account lockout. Device Code Flow enables CLI authentication.

Project-scoped RBAC provides five role levels (Owner, Admin, Operator, Member, Viewer) with granular resource-level permissions. Every route enforces authorization — routes that accept resource IDs verify both permission level and project ownership.

SSRF protection blocks private IP ranges and metadata endpoints on all outbound HTTP from tool execution.

#### Compliance (PCI, GDPR, SOC 2)

Encryption at rest uses tenant-scoped data encryption keys managed through KMS. Database fields containing sensitive data use field-level encryption. Secrets are never stored in plaintext.

Encryption in transit covers all inter-service communication via TLS and requires authentication before any WebSocket data exchange.

Data minimization enforces TTL-based retention on messages, sessions, and traces with configurable windows. Conversation history uses sliding windows to prevent unbounded growth.

Right to erasure cascades deletion across all associated data — sessions, messages, traces, resolution keys, and cached state. No orphaned PII.

Full audit logging captures authentication events, permission changes, data access, and administrative actions with actor identity, timestamp, and action.

**Data sovereignty** — the platform deploys on your infrastructure. Your Kubernetes cluster, your VPC, your data center, your sovereign cloud. Customer conversations and PII never leave your boundary. Encryption keys are yours.

#### Scaling

The runtime is stateless and distributed — any request can land on any pod, and sessions rehydrate automatically across pods. There is no pod-local state as a source of truth.

Rate limiting operates at tenant, API key, and session levels with distributed enforcement. Circuit breakers provide automatic recovery from downstream failures with configurable thresholds per tenant. Distributed locking and optimistic concurrency ensure safe concurrent operations across pods.

The storage architecture combines durable state (MongoDB), fast caching and distributed coordination (Redis cluster), and time-series analytics (ClickHouse).

#### Internationalization

The platform supports 50+ structured error codes with ICU MessageFormat templates for parameterized, locale-aware messages. Right-to-left language support covers Arabic, Hebrew, Farsi, Urdu, and Yiddish. The Studio UI provides 70+ localization namespaces.
