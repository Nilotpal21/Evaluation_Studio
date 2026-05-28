// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: guides/publishing-and-operations.mdx, admin/workspace-configuration.mdx
// Regenerate: pnpm abl:docs:generate

export const PROJECT_CONFIG_CARD = `## Project Configuration — Platform-Level Settings

# Publishing & Operations
- Once your agent is tested and ready, you need to publish it to production, manage environments, and monitor its performance.
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
3. Click **Rollback**.`;
