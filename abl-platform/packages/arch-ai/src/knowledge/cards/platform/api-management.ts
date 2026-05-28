// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: api-reference/management-apis.mdx
// Regenerate: pnpm abl:docs:generate

export const API_MANAGEMENT_CARD = `## Management APIs — Agents, Deployments, Tools, Callbacks

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
#### GET /api/agents/:name
Get full details for a specific agent by name, including the compiled specification.
**Auth required**: Yes
##### Path parameters
| Parameter | Type   | Description |
| --------- | ------ | ----------- |
| \`name\`    | string | Agent name  |
##### Response body
| Field     | Type    | Description                     |
| --------- | ------- | ------------------------------- |
| \`success\` | boolean | Whether the operation succeeded |
| \`agent\`   | object  | Agent detail object             |
Agent detail object:
| Field        | Type   | Description           |
| ------------ | ------ | --------------------- |
| \`id\`         | string | Agent ID              |
| \`name\`       | string | Agent name            |
| \`dslContent\` | string | Agent DSL source code |
##### Example request
\`\`\`bash
curl https://api.ablplatform.com/api/agents/support-agent \\
  -H "Authorization: Bearer abl_sk-your-api-key"
\`\`\`
##### Example response
\`\`\`json
{
  "success": true,
  "agent": {
    "id": "ag_001",
    "name": "support-agent",
    "dslContent": "AGENT: support-agent\\n..."
  }
}
\`\`\`
##### Cache behavior
- Agent detail responses include \`Cache-Control: private, max-age=300\` since agent specifications change infrequently.
---
### Project agents
- Manage agents within a specific project.
**Base path**: \`/api/projects/:projectId/agents\`
#### GET /api/projects/:projectId/agents
List all agents in a project.
**Auth required**: Yes
**Permission**: \`agent:read\`
##### Response body
| Field     | Type    | Description                  |
| --------- | ------- | ---------------------------- |
| \`success\` | boolean | Always \`true\` on success     |
| \`agents\`  | array   | List of agent detail objects |
Each agent object:
| Field            | Type           | Description                                 |
| ---------------- | -------------- | ------------------------------------------- |
| \`id\`             | string         | Agent ID                                    |
| \`name\`           | string         | Agent name                                  |
| \`agentPath\`      | string         | Full agent path (e.g., \`domain/agent-name\`) |
| \`description\`    | string or null | Agent description                           |
| \`versionCount\`   | number         | Number of saved versions                    |
| \`activeVersions\` | object         | Map of environment to active version        |
| \`createdAt\`      | string         | ISO 8601 creation timestamp                 |
| \`updatedAt\`      | string         | ISO 8601 last update timestamp              |
##### Example request
\`\`\`bash
curl https://api.ablplatform.com/api/projects/proj_abc/agents \\
  -H "Authorization: Bearer abl_sk-your-api-key"
\`\`\`
##### Example response
\`\`\`json
{
  "success": true,
  "agents": [
    {
      "id": "ag_001",
      "name": "support-agent",
      "agentPath": "helpdesk/support-agent",
      "description": "Customer support automation agent",
      "versionCount": 5,
      "activeVersions": {
        "dev": "3",
        "production": "2"
      },
      "createdAt": "2026-02-15T08:00:00.000Z",
      "updatedAt": "2026-03-10T14:30:00.000Z"
    }
  ]
}
\`\`\`
---
#### GET /api/projects/:projectId/agents/:agentName
Get a single agent with version count and DSL content.
**Auth required**: Yes
**Permission**: \`agent:read\`
##### Path parameters
| Parameter   | Type          | Description |
| ----------- | ------------- | ----------- |
| \`projectId\` | string (CUID) | Project ID  |
| \`agentName\` | string        | Agent name  |
##### Response body
\`\`\`json
{
  "success": true,
  "agent": {
    "id": "ag_001",
    "name": "support-agent",
    "agentPath": "helpdesk/support-agent",
    "description": "Customer support automation agent",
    "dslContent": "AGENT: support-agent\\n...",
    "versionCount": 5,
    "activeVersions": { "dev": "3", "production": "2" },
    "createdAt": "2026-02-15T08:00:00.000Z",
    "updatedAt": "2026-03-10T14:30:00.000Z"
  }
}
\`\`\`
---
#### PUT /api/projects/:projectId/agents/:agentName/dsl
- Save a working copy of the agent's DSL content.
**Auth required**: Yes
**Permission**: \`agent:write\`
##### Request body
| Field        | Type   | Required | Description                              |
| ------------ | ------ | -------- | ---------------------------------------- |
| \`dslContent\` | string | Yes      | ABL DSL source content (cannot be empty) |
##### Response body
\`\`\`json
{
  "success": true,
  "updatedAt": "2026-03-11T10:30:00.000Z"
}
\`\`\`
---
### Deployments
- Manage the deployment lifecycle for agent projects.
**Base path**: \`/api/projects/:projectId/deployments\`
#### POST /api/projects/:projectId/deployments
Create a new deployment with specified agent versions and configuration.
**Auth required**: Yes
**Permission**: \`deployment:create\`
##### Request body
| Field                     | Type   | Required | Description                                           |
| ------------------------- | ------ | -------- | ----------------------------------------------------- |
| \`environment\`             | string | Yes      | Target environment: \`dev\`, \`staging\`, or \`production\` |
| \`agentVersionManifest\`    | object | Yes      | Map of agent names to version strings (or \`"auto"\`)   |
| \`entryAgentName\`          | string | Yes      | Name of the entry-point agent                         |
| \`label\`                   | string | No       | Human-readable deployment label                       |
| \`description\`             | string | No       | Deployment description                                |
| \`modelOverrides\`          | object | No       | Model configuration overrides per agent               |
| \`settingsVersionId\`       | string | No       | Pin a specific project settings version               |
| \`workflowVersionManifest\` | object | No       | Map of workflow names to versions                     |
##### Example request
\`\`\`bash
curl -X POST https://api.ablplatform.com/api/projects/proj_abc/deployments \\
  -H "Authorization: Bearer abl_sk-your-api-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "environment": "production",
    "agentVersionManifest": {
      "support-agent": "3",
      "escalation-agent": "2"
    },
    "entryAgentName": "support-agent",
    "label": "v2.1 production release"
  }'
\`\`\`
##### Example response (201 Created)
\`\`\`json
{
  "success": true,
  "deployment": {
    "id": "dep_xyz789",
    "projectId": "proj_abc",
    "environment": "production",
    "status": "active",
    "label": "v2.1 production release",
    "description": null,
    "endpointSlug": "proj_abc-production-lk3m-a1b2c3",
    "entryAgentName": "support-agent",
    "agentVersionManifest": {
      "support-agent": "3",
      "escalation-agent": "2"
    },
    "createdAt": "2026-03-11T10:00:00.000Z",
    "createdBy": "user_123"
  }
}
\`\`\`
---
#### GET /api/projects/:projectId/deployments
List all deployments for a project.
**Auth required**: Yes
##### Response body
\`\`\`json
{
  "success": true,
  "deployments": [
    {
      "id": "dep_xyz789",
      "projectId": "proj_abc",
      "environment": "production",
      "status": "active",
      "label": "v2.1 production release",
      "endpointSlug": "proj_abc-production-lk3m-a1b2c3",
      "createdAt": "2026-03-11T10:00:00.000Z"
    }
  ]
}
\`\`\`
---
#### GET /api/projects/:projectId/deployments/:deploymentId
Get deployment details including channel count.
**Auth required**: Yes
##### Response body
\`\`\`json
{
  "success": true,
  "deployment": {
    "id": "dep_xyz789",
    "projectId": "proj_abc",
    "environment": "production",
    "status": "active",
    "label": "v2.1 production release",
    "description": null,
    "endpointSlug": "proj_abc-production-lk3m-a1b2c3",
    "entryAgentName": "support-agent",
    "agentVersionManifest": {
      "support-agent": "3",
      "escalation-agent": "2"
    },
    "channelCount": 2,
    "createdAt": "2026-03-11T10:00:00.000Z",
    "createdBy": "user_123"
  }
}
\`\`\`
---
#### POST /api/projects/:projectId/deployments/:deploymentId/retire
Retire a deployment. Active sessions are drained before full retirement.
**Auth required**: Yes
**Permission**: \`deployment:create\`
##### Response body
\`\`\`json
{
  "success": true,
  "deployment": {
    "id": "dep_xyz789",
    "status": "retired",
    "retiredAt": "2026-03-11T12:00:00.000Z"
  }
}
\`\`\`
---
#### POST /api/projects/:projectId/deployments/:deploymentId/rollback
Rollback a retired deployment to its previous active state.
**Auth required**: Yes
**Permission**: \`deployment:create\`
---
#### POST /api/projects/:projectId/deployments/:deploymentId/promote`;
