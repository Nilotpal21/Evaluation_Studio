// L2 knowledge card — Integration Setup Workflow.
// Loaded when the user mentions OAuth, "hook up", a SaaS provider name,
// or other phrases that indicate they want to wire up an external integration.
// Token estimate: ~1200 (~4 chars/token, content length ~4800 chars).

export const INTEGRATION_SETUP_WORKFLOW_CARD = `## Integration Setup Workflow

When the user wants to set up an integration with an external provider, follow this multi-step playbook.

### Step 1: Determine integration type
- SaaS provider (Slack, Salesforce, Notion, etc.) — use OAuth2 app + token flow.
- Internal REST API — use api_key, bearer, or basic auth.
- MCP server — use mcp_server_ops, not http.

### Step 2: Start a draft
\`integration_ops:start({ providerKey, sourceHint?: 'in_project', userIntent? })\`
Sets metadata.activeIntegrationDraftId on the session.

### Step 3: Check existing auth profile
\`platform_context:list_auth_profiles\` — reuse if exists.

### Step 4: Create auth profile
- OAuth: \`auth_ops:create({ authType: 'oauth2_app', name, ... })\`. Returns \`{ needsSecrets, flowId }\`. UI prompts via SecretInput. Re-invoke with same flowId.
- API key / bearer / basic / digest / azure_ad / custom_header — same two-step pattern.
- 'none' — single-call, no secrets.
- Never call \`auth_ops:create({ authType: 'oauth2_token' })\` — that's created by the OAuth callback automatically.

### Step 5: For OAuth, complete user consent
\`ask_user({ widgetType: 'OAuthLaunch', input: { authProfileId, authProfileRef, connectorName, connectionMode: 'per_user', scopes, providerLabel } })\`
On success, returns \`{ status: 'connected', oauthTokenProfileId, expiresAt }\`. The oauth2_token profile is created server-side.

### Step 6: For SaaS, create connection
\`connection_ops:create({ connectorName, authProfileId: <oauth2_token_id> })\`
Makes dynamic dropdowns work and surfaces the integration on the manual Connections page.

### Step 7: Create the tool
\`tools_ops:create({ toolType: 'http', name, dsl })\` — endpoint pointing at the provider's REST API, with auth_profile_ref to the oauth2_token or api_key profile.

### Step 8: Resolve dynamic options (optional)
\`connection_ops:resolve_options({ connectorName, actionName, propName, connectionId })\`. Render via SingleSelect/MultiSelect. Save chosen value as default param on the tool.

### Step 9: Wire to agent(s)
- \`read_agent({ agentName })\`
- Construct DSL with the new tool name appended to TOOLS:
- \`propose_modification({ agentName, dsl, rationale })\` — emits diff card.
- \`apply_modification({ proposalId })\` — persists.

### Step 10: Verify
\`tools_ops:test({ toolId, sampleInput })\` — sanitize errors before showing.

### Step 11: Complete
\`integration_ops:complete({ draftId })\` — only when all entities exist and last test passed.`;
