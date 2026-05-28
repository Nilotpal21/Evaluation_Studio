// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: admin/security-and-authentication.mdx, guides/tools-and-integrations.mdx
// Regenerate: pnpm abl:docs:generate

export const AUTH_PROFILES_CARD = `## Auth Profiles — Types, Credentials, OAuth Flows

## Authentication for Integrations
- Agent Platform 2.
### API keys
- API keys are the primary way to authenticate external applications that interact with your deployed agents.
- When your application makes a request to the Runtime API, it includes the API key in the \`X-API-Key\` header.
- 1.
- 2.
- 3.
- 4.
API keys carry permissions that control what the authenticated application can do:
- **Chat** -- Send messages to agents and receive responses
- **Read** -- Access session history, analytics, and agent metadata
- **Admin** -- Manage agents, configurations, and deployments
Follow the principle of least privilege -- a web chat widget only needs Chat permission.
**Key management best practices:**
- Use separate keys for separate environments (development, staging, production).
- Rotate keys periodically. Create a new key, update your application, then revoke the old key.
- Configure allowed origins for browser-based integrations. This prevents your key from being used on unauthorized websites.
- Never embed keys in client-side code that is not origin-restricted.
### SDK tokens
- SDK tokens authenticate client-side integrations (web widgets, mobile apps).
### Channel authentication
- For platform-specific channels (voice, messaging platforms, custom webhooks), the Runtime provides d
| Channel type        | Authentication method                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| **Web SDK**         | Public key exchange on \`/api/v1/sdk/init\`, then short-lived SDK session token |
| **Voice**           | Session tokens with platform-specific integration                             |
| **Webhooks**        | HMAC signature verification on incoming payloads                              |
| **Custom channels** | API key or JWT-based authentication                                           |
### Service-to-service authentication
- When agents call tools or external services, the platform handles authentication on behalf of the agent.
### Session security
Conversation sessions are protected with several measures:
- Sessions are scoped to a specific project and tenant.
- Session data is encrypted at rest.
- Session timeouts are configurable (idle timeout and absolute timeout).
- Sessions can be explicitly terminated.
## OAuth Configuration
- Use OAuth when connecting to APIs that require user-level or application-level authorization, such as Google Workspace, Salesforce, or Microsoft Graph.
### Client credentials (machine-to-machine)
\`\`\`abl
TOOLS:
  get_crm_contacts(query: string) -> {contacts: object[], total: number}
    description: "Search CRM contacts"
    type: http
    endpoint: "https://api.crm.com/v2/contacts/search"
    method: POST
    auth: oauth2_client
    auth_config:
      token_url: "https://auth.crm.com/oauth/token"
      client_id: "{{secrets.CRM_CLIENT_ID}}"
      client_secret: "{{secrets.CRM_CLIENT_SECRET}}"
      scopes: "contacts.read"
\`\`\`
- With \`oauth2_client\`, the runtime exchanges \`client_id\` and \`client_secret\` for an access token using the OAuth2 client credentials grant.
### User authorization (delegated access)
\`\`\`abl
TOOLS:
  list_calendar_events(date: string) -> {events: object[]}
    description: "List user's calendar events for a given date"
    type: http
    endpoint: "https://graph.microsoft.com/v1.0/me/calendar/events"
    method: GET
    auth: oauth2_user
    auth_config:
      token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token"
      client_id: "{{secrets.MS_CLIENT_ID}}"
      client_secret: "{{secrets.MS_CLIENT_SECRET}}"
      scopes: "Calendars.Read"
      provider: "microsoft"
\`\`\`
- With \`oauth2_user\`, the runtime uses a user-level access token obtained through the authorization code flow.
### Auth config properties
| Property        | Required | Description                                   |
| --------------- | -------- | --------------------------------------------- |
| \`token_url\`     | Yes      | Token endpoint URL                            |
| \`client_id\`     | Yes      | OAuth client ID (use \`{{secrets.X}}\`)         |
| \`client_secret\` | Yes      | OAuth client secret (use \`{{secrets.X}}\`)     |
| \`scopes\`        | Yes      | Space-separated list of permission scopes     |
| \`provider\`      | No       | Provider name for consent UI routing          |
| \`header_name\`   | No       | Custom header name (default: \`Authorization\`) |
### Custom header authentication
\`\`\`abl
TOOLS:
  search_docs(query: string) -> {results: object[]}
    description: "Search internal documents"
    type: http
    endpoint: "https://api.internal.com/v1/search"
    method: POST
    auth: custom
    auth_config:
      custom_headers:
        X-API-Token: "{{secrets.INTERNAL_TOKEN}}"
        X-Org-Id: "{{secrets.ORG_ID}}"
\`\`\`
Use \`auth: custom\` with \`custom_headers\` when the API uses non-standard authentication headers.
### OAuth in a reusable tool file
\`\`\`abl
TOOLS:
  base_url: "https://api.salesforce.com/v58.0"
  auth: oauth2_client
  timeout: 10000

  query_accounts(soql: string) -> {records: object[], totalSize: number}
    type: http
    endpoint: "/query"
    method: GET
    description: "Execute a SOQL query"

  create_lead(company: string, email: string) -> {id: string, success: boolean}
    type: http
    endpoint: "/sobjects/Lead"
    method: POST
    description: "Create a new lead"
\`\`\`
- Shared defaults (\`base_url\`, \`auth\`, \`timeout\`) apply to all tools in a \`.
### Troubleshooting
- **Token refresh fails silently:** Verify the \`token_url\` is correct and the client credentials have not been revoked. Check that \`scopes\` match what the API requires.
- **User not prompted for consent:** Ensure \`auth: oauth2_user\` is set (not \`oauth2_client\`). The \`provider\` field must match a configured OAuth provider in the runtime.
- **Secrets not resolved:** Secret references (\`{{secrets.X}}\`) are resolved at runtime. Verify the secret exists in the project's secret store with the exact key name.`;
