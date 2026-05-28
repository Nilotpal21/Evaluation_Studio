// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: studio/tools-knowledge-connections.mdx, studio/testing-deployment-operations.mdx
// Regenerate: pnpm abl:docs:generate

export const WORKFLOWS_AUTHORING_CARD = `## Workflows — Nodes, Triggers, Execution, Approvals

## Workflows
- Workflows define multi-step processes that coordinate agent actions, external service calls, and human approvals.
### Workflows list
- Navigate to **Workflows** from the project sidebar to view all workflows in your project.
### Creating a workflow
1. Click the **Create Workflow** button.
2. In the creation modal, fill in:
   - **Name** -- a descriptive name for the workflow.
   - **Description** (optional) -- explains what the workflow automates.
   - **Trigger type** -- how the workflow is initiated (manual, scheduled, event-driven, or agent-triggered).
3. Click **Create** to be taken to the workflow detail page.
### Workflow detail page
- The workflow detail page provides a comprehensive view of the workflow's configuration, execution steps, and run history.
**Workflow steps** -- define the sequence of actions:
- **Agent steps** -- invoke an agent to handle part of the process.
- **Tool steps** -- execute a tool (HTTP call, code execution).
- **Approval steps** -- pause execution and wait for human approval.
- **Conditional steps** -- branch based on data or previous step results.
- **Delay steps** -- wait for a specified duration before continuing.
- **Status management** -- workflows have a lifecycle status of Active (operational and can be triggered), Paused (temporarily disabled), or Archived (no longer in use but retained for reference).
### Execution monitoring
- The workflow detail page shows a history of all executions (runs).
### Workflow approvals
- When a workflow reaches an approval step, a task is created in the **Inbox** (see [Testing, deployment & operations](.
## Operations
- Operations pages provide tools for monitoring, troubleshooting, and intervening in live agent conversations.
### Session browser
- Navigate to **Operate > Sessions** from the project sidebar.
- **Sessions list** -- conversations are displayed in a sortable, filterable table with columns for Session ID (click to copy), Agent Name, Created At, Message Count, and Trace Event Count.
- The sessions page provides two tabs: **Conversations** (the session table view) and **Traces** (a dedicated trace viewer for exploring execution traces across all sessions).
**Session detail view** -- click any session row to open the session detail page:
- **Conversation tab** -- full conversation transcript, agent conversation tree visualization showing branching across agents in multi-agent projects, and session summary panel with metadata.
- **Trace tab** -- execution trace timeline showing every action the agent took, including LLM calls, tool invocations, handoffs, state changes, and errors. Each event shows timing information and expandable request/response payloads.
- > **Tip:** Use the trace tab to diagnose why an agent behaved unexpectedly.
### Human-in-the-loop inbox
- Navigate to **Operate > Inbox** from the project sidebar.
**Task types:**
| Type           | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| **Approval**   | A workflow step or agent action requires explicit approval before proceeding |
| **Data Entry** | The agent needs information that must be provided by a human operator        |
| **Review**     | Agent output or a decision requires human review before finalization         |
| **Decision**   | A choice point where a human must select the next course of action           |
| **Escalation** | An agent has escalated an issue that it cannot resolve autonomously          |
- Filter tabs at the top of the inbox let you view all tasks or filter to a specific type.
- Click a task card to expand the action panel: approve/reject approvals, fill in data entry forms, mark reviews as reviewed, select from decision options, or resolve escalations.
### Transfer sessions
- Navigate to **Operate > Transfer Sessions** from the project sidebar.
- The transfer session table displays Session ID, Status, Provider (e.
**Status values:**
| Status         | Description                                            |
| -------------- | ------------------------------------------------------ |
| **Pending**    | Transfer initiated, waiting to be picked up            |
| **Queued**     | Transfer is in the queue for the target agent or human |
| **Active**     | Transfer is in progress                                |
| **Post-Agent** | Transfer completed, in post-processing                 |
| **Ended**      | Transfer is complete                                   |
- Use filter dropdowns (provider, status, channel) to narrow the view.`;
