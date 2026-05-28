// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: guides/publishing-and-operations.mdx, api-reference/management-apis.mdx
// Regenerate: pnpm abl:docs:generate

export const DEPLOYMENTS_LIFECYCLE_CARD = `## Deployments — Environments, Versioning, Promotion

## Publish an Agent
- Deploy a versioned snapshot of your agents to a target environment so end users can interact with them through channels and APIs.
### Create Agent Versions
- Before deploying, create versioned snapshots of your agents.
1. Open your project in Studio.
2. Select the agent you want to version.
3. Click **Create Version** in the toolbar.
4. Enter a version label (e.g., \`1.0.0\`) and optional changelog.
5. Click **Save Version**.
- Repeat for every agent included in the deployment.
### Deploy via Studio
1. Navigate to **Project Settings > Deployments**.
2. Click **New Deployment**.
3. Configure the deployment:
| Field                      | Description                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| **Environment**            | Target environment: \`dev\`, \`staging\`, or \`production\`                                        |
| **Entry agent**            | The agent that receives incoming messages (typically the supervisor)                         |
| **Agent version manifest** | Map each agent name to a version (or select \`auto\` to version from the current working copy) |
| **Label**                  | Human-readable deployment label (e.g., "v1.2 - Added refund flow")                           |
| **Description**            | Optional notes about what changed                                                            |
4. Click **Deploy**.
- The platform validates all agent versions, resolves \`{{config.
### Deploy via API
\`\`\`bash
curl -X POST /api/projects/:projectId/deployments \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "environment": "production",
    "entryAgentName": "Airlines_Supervisor",
    "agentVersionManifest": {
      "Airlines_Supervisor": "1.0.0",
      "Flight_Search": "1.0.0",
      "Policy_Advisor": "1.0.0"
    },
    "label": "v1.0 - Initial release"
  }'
\`\`\`
Use \`"auto"\` as the version value to auto-create a version from the current working copy:
\`\`\`json
{
  "agentVersionManifest": {
    "Airlines_Supervisor": "auto",
    "Flight_Search": "auto"
  }
}
\`\`\`
### Deployment Lifecycle
Deployments transition through these statuses:
| Status     | Meaning                                               |
| ---------- | ----------------------------------------------------- |
| \`active\`   | Receiving new sessions and serving traffic            |
| \`draining\` | No new sessions; existing sessions complete naturally |
| \`retired\`  | Fully decommissioned, no traffic                      |
- Only one deployment per environment can be \`active\` at a time.
### Rollback a Deployment
If a deployment causes issues, roll back to the previous version:
1. Navigate to **Deployments**.
2. Find the problematic deployment.
3. Click **Rollback**.
This retires the current deployment and reactivates the previous one. Alternatively, via API:
\`\`\`bash
curl -X POST /api/projects/:projectId/deployments/:deploymentId/rollback \\
  -H "Authorization: Bearer \$TOKEN"
\`\`\`
### Deploy with Model Overrides
Override LLM model settings per agent without changing ABL code:
\`\`\`json
{
  "environment": "production",
  "entryAgentName": "Supervisor",
  "agentVersionManifest": { "Supervisor": "1.0.0" },
  "modelOverrides": {
    "Supervisor": {
      "model": "claude-sonnet-4-5-20250929",
      "temperature": 0.3
    }
  }
}
\`\`\`
### Deploy with Workflow Versions
If your project includes workflows, include them in the manifest:
\`\`\`json
{
  "workflowVersionManifest": {
    "order_processing": "1.0.0",
    "refund_workflow": "auto"
  }
}
\`\`\`
### Troubleshooting
- **"Agent not found" error:** Verify all agent names in the manifest match the exact names in your project (case-sensitive).
- **"Version not found" error:** Create the version first or use \`"auto"\` to version from the current working copy.
- **Missing environment variables warning:** The deployment succeeds but warns about unresolved \`{{env.KEY}}\` references. Add the missing variables in the target environment's settings.
- **Channels not updating:** Verify channels are configured with auto-follow enabled for the target environment.
## Set Up Environments
- Use environments to separate development, testing, and production configurations for the same agent project.
### Understand the Environment Model
Agent Platform 2.0 supports three built-in environments per project:
| Environment  | Purpose                                                      |
| ------------ | ------------------------------------------------------------ |
| \`dev\`        | Active development and Studio testing                        |
| \`staging\`    | Pre-production validation with production-like configuration |
| \`production\` | Live traffic from end users via channels and APIs            |
- Each environment has its own deployment (the active agent version manifest), environment variables (key-value configuration resolved at runtime), channel bindings (which channels route to this environment), and model overrides (per-environment LLM model settings).
### Configure Environment Variables
- Environment variables let you change agent behavior per environment without modifying ABL code.
1. Open **Project Settings > Environment Variables**.
2. Select the target environment tab (\`dev\`, \`staging\`, or \`production\`).
3. Click **Add Variable**.
4. Enter the key, value, and optional description.
5. Toggle **Secret** if the value is sensitive (secrets are write-only after saving).
6. Click **Save**.
Example variables:
\`\`\`
Environment: production
+----------------------+-------------------------------+--------+
| Key                  | Value                         | Secret |
+----------------------+-------------------------------+--------+
| API_BASE_URL         | https://api.example.com       | No     |
| SUPPORT_EMAIL        | support@example.com           | No     |
| PAYMENT_API_KEY      | ********                      | Yes    |
| FEATURE_NEW_FLOW     | true                          | No     |
+----------------------+-------------------------------+--------+
\`\`\`
Reference in ABL:
\`\`\`abl
TOOLS:
  process_payment:
    description: "Process a payment"
    type: http
    endpoint: "{{env.API_BASE_URL}}/payments"
    auth: bearer
\`\`\`
### Set Up Environment-Specific Deployments
Create separate deployments per environment, each pointing to the appropriate agent versions:
\`\`\`bash
# Deploy to dev with auto-versioning
curl -X POST /api/projects/:projectId/deployments \\
  -d '{"environment": "dev", "entryAgentName": "Supervisor", "agentVersionManifest": {"Supervisor": "auto"}}'

# Deploy to staging with pinned versions
curl -X POST /api/projects/:projectId/deployments \\
  -d '{"environment": "staging", "entryAgentName": "Supervisor", "agentVersionManifest": {"Supervisor": "1.2.0"}}'

# Promote staging to production
curl -X POST /api/projects/:projectId/deployments/:stagingDeploymentId/promote \\
  -d '{"targetEnvironment": "production"}'
\`\`\`
### Route Channels to Environments
Each channel (web widget, voice, messaging integration) is bound to a specific environment:
1. Open **Project Settings > Channels**.
2. Select a channel.
3. Set its **Environment** to \`dev\`, \`staging\`, or \`production\`.
- 4.
### Feature Flags via Environment Variables
Use environment variables as feature flags:
\`\`\`abl
FLOW:
  steps:
    - check_feature

check_feature:
  REASONING: false
  THEN:
    - IF: "{{env.FEATURE_NEW_FLOW}}" == "true"
      THEN: new_flow_step
    - ELSE:
      THEN: legacy_flow_step
\`\`\`
Set \`FEATURE_NEW_FLOW=true\` in staging to test, then flip it in production when ready.
### Copy Variables Between Environments
When setting up a new environment, copy variables from an existing one:
1. Open the source environment tab.
2. Click **Copy to...** and select the target environment.
3. Review and modify values as needed (secrets are not copied -- re-enter them).
### Troubleshooting
- **"Missing environment variable" warning on deploy:** The deployment detects \`{{env.KEY}}\` references in your agents that do not have corresponding variables defined for the target environment. Add the missing variables before deploying.
- **Variable changes not taking effect:** Environment variables are resolved at session start. Existing sessions use the values from when they were created. New sessions pick up the latest values.
- **Cannot read secret value:** Secret variables are write-only after saving. You can update or delete them but cannot view the stored value.
# Management APIs
- The management APIs provide endpoints for discovering agents, managing project-level agent definitions, creating deployments, coordinating between agents via handoffs and delegation, and managing tool secrets.
## Agent Management API
### Agent discovery
List and inspect agents across your tenant.
**Base path**: \`/api/agents\`
#### GET /api/agents
List all agents accessible to the authenticated tenant.
**Auth required**: Yes
##### Response body
| Field     | Type    | Description                     |
| --------- | ------- | ------------------------------- |
| \`success\` | boolean | Whether the operation succeeded |
| \`total\`   | number  | Total number of agents          |
| \`agents\`  | array   | List of agent metadata objects  |
Each agent object:
| Field  | Type   | Description |
| ------ | ------ | ----------- |
| \`id\`   | string | Agent ID    |
| \`name\` | string | Agent name  |
##### Example request
\`\`\`bash
curl https://api.ablplatform.com/api/agents \\
  -H "Authorization: Bearer abl_sk-your-api-key"
\`\`\`
##### Example response
\`\`\`json
{
  "success": true,
  "total": 3,
  "agents": [
    { "id": "ag_001", "name": "support-agent" },
    { "id": "ag_002", "name": "sales-agent" },
    { "id": "ag_003", "name": "onboarding-agent" }
  ]
}
\`\`\`
---
#### GET /api/agents/:name`;
