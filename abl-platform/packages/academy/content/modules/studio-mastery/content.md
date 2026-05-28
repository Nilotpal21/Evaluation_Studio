# Studio Mastery

> **Estimated time**: 40 minutes | **Prerequisites**: Basic familiarity with ABL concepts and agent building

## Learning Objectives

After completing this module, you will be able to:

- Navigate Studio's project workspace, sidebar, and command palette efficiently
- Create projects using orchestration patterns and understand how pattern-aware creation works
- Build and test agents using the visual editor, code editor, and integrated chat
- Manage tools, knowledge bases, connections, and workflows
- Use the Insights dashboard, Operate pages, and alert rules for production monitoring

## Getting Around Studio

Studio is the browser-based IDE for the entire agent lifecycle -- from initial design through production operations. Understanding its layout is the first step to working efficiently.

### The Projects Dashboard

When you sign in, you see the **Projects dashboard** -- a grid of project cards showing name, description, orchestration pattern badge, agent count, and last-updated timestamp. Search projects from the bar at the top, create new projects from the header dropdown, or click any card to enter that project's workspace.

### The Header Bar

Always visible, the header contains:

- **Logo** -- click to return to the Projects dashboard
- **Breadcrumb trail** -- shows your current location (e.g., Projects > My Agent > Agents)
- **Connection status** -- green/red dot for WebSocket connectivity
- **AI Architect toggle** -- opens the context-aware assistant panel
- **Theme toggle** -- light/dark mode
- **Admin link** -- workspace-level administration

### The Project Sidebar

Inside a project, the left sidebar organizes navigation into three sections:

**Build**: Overview, Agents, Workflows

**Resources**: Tools, Knowledge Bases, Integrations

**More** (expandable groups):

- **Evaluate**: Evaluations, Experiments
- **Operate**: Sessions, Deployments, Inbox, Alerts, Transfer Sessions
- **Insights**: Dashboard, Agent Performance, Quality Monitor, Customer Insights, Voice Analytics
- **Govern**: Guardrails, Governance
- **Settings**: Members, API Keys, Models, Config Variables, Git, Advanced, and more

The sidebar collapses to icon-only mode for more horizontal space and auto-collapses when the agent editor is active.

### Command Palette

Press **Cmd+K** (macOS) or **Ctrl+K** (Windows/Linux) from anywhere to open the command palette. It provides fuzzy search across navigation pages, agents by name, and quick actions. This is the fastest way to navigate large projects.

## Project Management

### Orchestration Patterns and the Concierge Pattern

Every project uses an orchestration pattern that determines how agents coordinate:

| Pattern                     | Description                                                            | Best For                                        |
| --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| **Concierge** (recommended) | A single front-facing agent delegates to specialists behind the scenes | Customer service, help desk, general assistants |
| **Router**                  | A triage agent routes requests to specialists directly                 | Multi-department support, intent-based routing  |
| **Tiered**                  | Triage routes to L1 agents that can escalate to L2                     | Technical support with escalation paths         |
| **Custom**                  | No predefined structure; any topology                                  | Advanced flexible orchestration                 |

> **Key Concept**: When you choose the **Concierge pattern**, Studio auto-assigns the **Specialist role** to every agent created after the first one. The first agent gets the Concierge role; all subsequent agents become Specialists. A context panel in the creation dialog explains how the new agent fits into the pattern, including which coordination blocks (such as ESCALATE rules) will be pre-configured. This saves significant setup time compared to manually wiring agent roles.

The Router pattern assigns Triage to the first agent and Specialist to the rest. The Tiered pattern assigns Triage first, then lets you choose between L1 and L2 tiers.

Choosing a pattern does not lock you in -- it pre-configures roles and coordination blocks to save time.

### Creating Projects

Studio offers three creation paths:

1. **AI-guided** (recommended for new users): The AI Architect wizard walks through interview, optional document upload, generation, review, and creation phases.
2. **Blank project**: Manual configuration with name, description, and orchestration pattern selection.
3. **From template**: Pre-built configurations for common use cases.

### Import and Export

From the project overview, **Export** creates a downloadable package of agent definitions and project configuration. **Import** merges uploaded agents into the current project.

> **Key Concept**: Importing does **not overwrite** existing agents. If an agent with the same name already exists in the target project, the import process flags the conflict for manual resolution rather than silently replacing the existing agent. This prevents accidental loss of work when importing from other projects or team members.

## The Agent Editor

### Creating Agents

Navigate to **Agents** in the sidebar, click **Create Agent**, and configure:

- **Name** -- letters, numbers, underscores (max 100 characters)
- **Execution mode** -- blank (LLM-driven) or with FLOW section for structured steps
- **Description** (optional)

### Editor Layout and Sections

The editor organizes configuration into 17 sections across six groups:

**Identity & Core**: Identity (name, persona, goal), Execution (model, temperature, limits), Tools

**Data & Logic**: Gather, Memory, Flow

**Safety & Behavior**: Constraints, Guardrails, Behavior profiles

**Coordination**: Handoffs, Delegates, Escalation

**Lifecycle**: On Start, Error Handling, Completion

**Advanced**: Templates, Definition (raw ABL code)

Each section includes an AI Architect button for context-aware assistance.

### Visual Flow Editor

The visual flow editor provides a graphical canvas for designing agent conversation flows. The editor experience differs based on the agent's execution mode.

#### Reasoning vs. Scripted Editor Modes

Agent Platform distinguishes between two agent types, each with a different editing experience:

**Reasoning agents** (no FLOW section) are LLM-driven -- they decide what to do based on their instructions, tools, and context. For reasoning agents, the editor provides a **full-page configuration panel** with sections for identity, execution settings, tools, constraints, guardrails, and coordination. There is no canvas because the agent does not follow a predetermined flow.

**Scripted agents** (with a FLOW section) follow explicit step-by-step flows defined in ABL. For scripted agents, the editor provides a **flow canvas** where steps appear as connected nodes, plus a **configuration sidebar** for editing step properties. This is the visual flow editor.

> **Key Concept**: The editor mode is determined by whether the agent has a FLOW section. Reasoning agents get a full-page config panel (no canvas). Scripted agents get a flow canvas with a step property sidebar. Understanding this distinction helps you choose the right editing approach for your agent type.

#### Canvas Components

The flow canvas provides several interactive components:

- **Step nodes** -- Each flow step appears as a draggable card on the canvas showing the step name, type icon, and a summary of its configuration
- **Transition edges** -- Lines connecting steps show the flow of conversation. Conditional transitions show the condition label on the edge
- **Step palette** -- A panel offering step types to drag onto the canvas: response steps (RESPOND), data collection steps (GATHER), conditional branching (IF/ELSE), tool invocation steps, SET/CLEAR operations, and completion steps (COMPLETE, HANDOFF, ESCALATE)
- **Minimap** -- A small overview panel showing the entire flow layout, useful for navigating large flows
- **Zoom controls** -- Zoom in/out and fit-to-screen buttons

#### Step Property Sidebar

Clicking any step node opens the **step property sidebar** on the right side of the canvas. The sidebar shows editable fields specific to the step type:

- **Response steps**: Message text, rich content blocks, voice overrides
- **Gather steps**: Field definitions, validation rules, prompts, retry behavior
- **Conditional steps**: Condition expressions, THEN/ELSE targets
- **Tool steps**: Tool selection, input mapping, output variable assignment
- **SET steps**: Variable assignments and expressions

#### Conditional Branching

Create conditional flows by adding IF/ELSE transitions between steps. The canvas renders branching paths visually, making it easy to see the conversation tree:

```
collect_info → [IF has_booking] → modify_booking
                                → [ELSE] → new_booking → confirm → COMPLETE
```

Each conditional edge displays its condition label. Complex flows with multiple branches are easier to reason about visually than in code.

#### Visual Debugging

When testing an agent in the integrated chat, the flow canvas highlights the **current active step** in real time. As the conversation progresses, you can watch the agent move through the flow -- step nodes light up as they execute, and transition edges animate to show the path taken. This visual debugging makes it immediately obvious when the agent takes an unexpected path.

### View Modes

Switch between:

- **Visual mode** -- section-based UI or flow canvas
- **Code mode** -- full ABL code editor with syntax highlighting (Monaco editor)

Changes synchronize between modes.

### Agent Versioning

The Versions tab shows all saved versions with status badges (draft, testing, staged, active, deprecated). Use the diff viewer to compare versions side-by-side. Promote versions through the status pipeline to control the deployment lifecycle.

## Testing Agents in Studio

### The Integrated Chat

Open any agent and switch to the **Chat** tab to test interactively. Type messages and see the agent's responses in real time.

> **Key Concept**: The Studio chat preview is powered by the **same Web SDK** components (`ChatWidget` via `AgentProvider`) that end users see in deployed widgets. Studio wraps the SDK with a **`StudioTransport`** adapter that bridges the existing WebSocket connection. This means the preview accurately reflects production rendering -- including rich content templates, action buttons, and streaming behavior. Studio-specific features (debug panel, session health banner) are layered on top without modifying the SDK components.

This matters because what you see in the Studio chat is what your users will see. There is no separate "preview renderer" that might behave differently.

### The Debug Panel

The chat view includes a split-pane debug panel showing:

- **Trace events** -- every action (LLM calls, tool invocations, state changes)
- **Timing information** -- latency for each operation
- **Variable state** -- current session variable values

Use the debug panel to understand why an agent made a particular decision.

## Managing Resources

### Tools

The Tools page organizes tools by type: **HTTP Tools**, **Code Tools** (sandboxed execution), and **MCP Servers** (Model Context Protocol). Each tab shows a count badge and supports search.

Create HTTP tools manually or by importing from a cURL command. Test any tool from its card using the integrated test dialog with auto-generated input forms.

### Knowledge Bases

Navigate to **Knowledge Bases** to create document stores for RAG (retrieval-augmented generation). Upload PDFs, DOCX, TXT, or Markdown files. The platform processes documents through an ingestion pipeline (extraction, chunking, embedding, indexing).

The detail page has tabs for Overview, Documents, Connectors, Web Crawler, Fields, Vocabulary, Knowledge Graph, Query Playground, and Settings.

### Connections and Integrations

The Connections page has two sections:

- **My connections** -- active connections with status indicators
- **Connector catalog** -- browsable by category (CRM, Messaging, Ticketing, Analytics, Data)

OAuth-based connectors open an authorization window for the target service directly from Studio.

### Workflows

Build multi-step processes combining agent steps, tool steps, approval steps, conditional branching, and delays. Monitor execution history with step-by-step progress tracking and timing information.

## Evaluations

### The Eval Framework

The Evaluations page (under **Evaluate**) has five tabs:

| Tab            | Purpose                                           |
| -------------- | ------------------------------------------------- |
| **Personas**   | Synthetic user profiles simulating real customers |
| **Scenarios**  | Test conversation scripts and situations          |
| **Evaluators** | Automated judges that score responses             |
| **Eval Sets**  | Bundles of personas + scenarios + evaluators      |
| **Runs**       | Execute evaluations and review results            |

**Quick Eval** provides a shortcut for ad-hoc evaluation without full setup.

### Reviewing Results

Completed runs show overall score averages, score distributions, and pass/fail rates. Drill into individual conversations for full transcripts and per-evaluator scores. Use **Comparison view** to compare runs and **Heatmap view** to see scores across persona-scenario combinations.

## Operations and Monitoring

### Session Browser

Navigate to **Operate > Sessions** to browse all conversations. Filter by date range, sort by columns, and click sessions to see:

- **Conversation tab** -- full transcript and agent conversation tree
- **Trace tab** -- execution trace timeline with expandable payloads

### Human-in-the-Loop Inbox

The **Inbox** consolidates tasks requiring human attention: Approvals, Data Entry, Reviews, Decisions, and Escalations. Each task has priority indicators and SLA countdowns. The inbox polls every 5 seconds.

### Transfer Sessions

Monitor active agent transfers under **Operate > Transfer Sessions**. The table shows session ID, status, provider (SmartAssist, Genesys, NICE, Five9), channel, and timestamps.

## Insights Dashboard

### Key Performance Indicators

The main **Dashboard** under Insights displays five KPI metric cards:

| Metric               | Description                                              |
| -------------------- | -------------------------------------------------------- |
| **Sessions**         | Total conversation count in the selected period          |
| **Messages**         | Total messages exchanged                                 |
| **Tokens**           | Total LLM tokens consumed                                |
| **Estimated Cost**   | Computed from token usage and model pricing              |
| **Containment Rate** | Percentage of sessions resolved without human escalation |

> **Key Concept**: **Containment Rate** measures the percentage of sessions that the agent resolved autonomously, without needing to escalate to a human. This is one of the most important operational KPIs because it directly reflects how effectively your agents handle real user requests. A declining containment rate signals that agents need improvement -- either better instructions, more tools, or refined handoff logic.

Each metric card includes a trend indicator showing percentage change compared to the previous period. Select from 7-day, 30-day, or 90-day date ranges.

### Cost Breakdown

Below the trend charts, a cost breakdown table groups spending by agent, showing sessions handled, tokens consumed, and estimated cost. Use this to identify which agents drive the most resource consumption.

## Alerts and Alert Rules

### The Alerts Page

Navigate to **Operate > Alerts** to find two tabs:

**Approvals** -- workflow steps waiting for human approval (focused view of inbox approval tasks).

**Alert Rules** -- configure automated notifications.

> **Key Concept**: **Alert rules** are configured under the **Operate** tab (specifically **Operate > Alerts > Alert Rules**), not under Insights or Settings. You can set up automated notifications for error rate spikes, session volume changes, SLA breaches, evaluation score drops, and deployment events. Each rule has a trigger condition and a notification target (email, webhook for Slack/PagerDuty integration, or in-app notification).

## Guardrails and Governance

Configure content safety under **Govern > Guardrails**:

- **Policies** -- define rules for content filtering with severity levels (Low = log, Medium = warn, High = block)
- **Providers** -- workspace-level guardrail provider configurations
- **Audit** -- history of guardrail evaluations and enforcement actions

Built-in templates cover basic safety, enterprise compliance, and healthcare scenarios.

## Project Settings

Key settings pages:

| Page                 | Purpose                                         |
| -------------------- | ----------------------------------------------- |
| **Members**          | Access control with Admin, Editor, Viewer roles |
| **API Keys**         | Programmatic access keys with expiration        |
| **Models**           | Available LLM models and default selection      |
| **Config Variables** | Runtime key-value pairs for tools and agents    |
| **Git**              | Repository connection and sync configuration    |
| **Runtime Config**   | Session timeout, concurrency, rate limits       |
| **Trace Dimensions** | Custom metadata fields for trace analytics      |
| **Agent Transfer**   | Contact center provider and queue configuration |
| **PII Protection**   | Detection patterns and handling rules           |

## Key Takeaways

- The **Concierge pattern** auto-assigns the **Specialist role** to subsequent agents, pre-configuring coordination blocks and saving setup time
- Studio's chat preview uses the **same Web SDK** with a **`StudioTransport`** adapter, so what you test is exactly what users see in production
- **Containment Rate** is a critical KPI measuring sessions resolved without human escalation -- track it on the Insights dashboard
- **Alert rules** are configured under **Operate > Alerts**, with support for error rate, volume, SLA, and deployment event triggers
- **Import does not overwrite** existing agents -- conflicts are flagged for resolution, preventing accidental data loss

## What's Next

Explore the **Production Deployment** module for the deployment lifecycle, environment variables, and channel configuration. See the **Multi-Agent Fundamentals** module to build supervisor-routed agent systems.
