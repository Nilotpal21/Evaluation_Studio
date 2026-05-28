// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: studio/tools-knowledge-connections.mdx
// Regenerate: pnpm abl:docs:generate

export const CONNECTIONS_INTEGRATIONS_CARD = `## Connections — Connector Catalog & Integration Wiring

## Connections & integrations
- Connections enable your project to communicate with third-party services such as CRM systems, messaging platforms, ticketing tools, analytics services, and data sources.
### Connections page layout
The Connections page is organized into two sections:
- **My connections** -- the top section displays your active connections as compact cards showing the connector logo, connection name, a status indicator (green for connected, red for error), and last verified timestamp.
- **Connector catalog** -- the bottom section displays the full catalog of available connectors, organ
| Category      | Examples                                |
| ------------- | --------------------------------------- |
| **CRM**       | Salesforce, HubSpot, Microsoft Dynamics |
| **Messaging** | Slack, Microsoft Teams, WhatsApp        |
| **Ticketing** | Zendesk, ServiceNow, Jira               |
| **Analytics** | Google Analytics, Mixpanel, Amplitude   |
| **Data**      | PostgreSQL, MySQL, MongoDB, REST APIs   |
Each catalog card shows the connector name, logo, a brief description, and a **Connect** button.
### Creating a connection
- 1.
2. In the creation modal, fill in:
   - **Connection name** -- a descriptive label for this connection instance.
   - **Credentials** -- service-specific configuration (API keys, OAuth tokens, endpoint URLs, etc.).
   - **Options** -- any connector-specific settings.
- For connectors that use OAuth, Studio opens an authorization window for the target service.
### Testing and managing connections
- After creating a connection, click on the connection card and use the **Test** button to verify connectivity.
- From the expanded connection panel you can also **Edit** connection details (name, credentials, options) or **Delete** the connection.
- > **Tip:** Test connections periodically, especially after credential rotations or service configuration changes.
- > **Warning:** Deleting a connection may break agents or workflows that depend on it.
### Using connections in agents
- Connections are used by agents through tools.
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
- When a workflow reaches an approval step, a task is created in the **Inbox** (see [Testing, deployment & operations](.`;
