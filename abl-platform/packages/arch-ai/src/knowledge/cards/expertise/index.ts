// Expertise cards — hand-written operational guides for Arch AI specialists.
// These provide decision trees, tool sequences, pitfalls, and cross-feature guidance.
// Placeholders until Task 5 writes the full content.

export const CHANNELS_OPERATIONS_CARD = `## Channels — Operational Guide

### Decision Tree: Which Channel Type?
| User Intent | Recommended Channel | Notes |
|-------------|-------------------|-------|
| Web chat widget | sdk_web | Simplest; embed code + API key |
| Mobile app | sdk_mobile | Same SDK, different embed |
| REST API integration | sdk_api or http_async | http_async for webhook-based |
| Slack bot | slack | Needs bot_token + signing_secret |
| WhatsApp business | whatsapp | Meta Business API or Infobip |
| Voice calls | voice_pipeline (telephony) or voice_realtime (S2S) | S2S = browser/app; pipeline = phone numbers |
| Agent-to-agent | a2a | A2A protocol, needs external agent registered |

### Tool Sequence: Create Channel
1. channel_ops(action: "list_types") — show options with capabilities
2. Ask user: which type + display name
3. If credentials required → for each credential field:
   - call collect_secret(fieldName, description)
4. channel_ops(action: "create", { channelType, displayName, credentials })
5. channel_ops(action: "test") — verify connection
6. Suggest: channel_ops(action: "bind_env", { environment: "dev" })

### Common Pitfalls
- Slack: signing_secret ≠ bot_token (users confuse them constantly)
- WhatsApp: Meta webhook verification needs channel active FIRST, then configure webhook
- Voice S2S: workspace-level voice service must be configured by admin BEFORE channel creation
- SDK Web: CORS origin domains must match or widget silently fails
- A2A: external agent must be registered + test-connection passing before channel works

### Cross-Feature Dependencies
- Channel → Deployment: must bind to environment to receive traffic
- Channel credentials → internally stored as encrypted auth profile
- Voice channels → require admin Voice Services config (LiveKit/Twilio keys)
- A2A channel → requires External Agent registry entry
- SDK channels → generate embed tokens via API keys

### When to Use search_docs
- Exact webhook payload format for a specific provider
- Provider-specific rate limits or message format constraints
- Troubleshooting a specific error code
- Multi-workspace Slack app configuration details
`;

export const DEPLOYMENT_OPERATIONS_CARD = `## Deployments — Operational Guide

### Decision Tree: When to Deploy/Promote
| Situation | Action | Notes |
|-----------|--------|-------|
| First time, just testing | Create dev deployment | Minimal config needed |
| Dev stable, want staging | Promote dev → staging | Verify agents compile, tests pass |
| Staging validated | Promote staging → production | Ensure channels bound, variables set |
| Production broken | Rollback | Reactivates previous deployment |
| Old deployment blocking | Retire | Deactivates without replacement |

### Tool Sequence: Full Deployment Pipeline
1. deployment_ops(action: "list") — check current state
2. If no deployments → deployment_ops(action: "create", { environment: "dev" })
3. Verify: all agents compiled? Run validate_agent on each
4. Promote: deployment_ops(action: "promote", { deploymentId, targetEnv: "staging" })
5. Bind channels: channel_ops(action: "bind_env", { channelId, environment: "staging" })
6. Test: send test message through bound channel
7. Promote to production when staging validates

### Pre-Promotion Checklist
- All agents compile without errors (validate_agent)
- Test scenarios pass (run_test)
- Environment variables configured for target env
- Channels exist and are bound to target environment
- Auth profiles valid (auth_ops validate)

### Rollback Criteria
- Error rate spike after promotion
- Agent crashes or empty responses
- Tool integration failures (check traces)
- User-reported issues

### When to Use search_docs
- Environment variable inheritance rules
- Deployment snapshot comparison details
- Git-based deployment automation setup
`;

export const AUTH_OPERATIONS_CARD = `## Auth Profiles — Operational Guide

### Decision Tree: Which Auth Type?
| Integration Needs | Recommended Type | Notes |
|-------------------|-----------------|-------|
| Simple API with static key | api_key | Fastest setup |
| Bearer token (JWT, etc.) | bearer | Static token, no refresh |
| User needs to authorize (Google, Microsoft) | oauth2_app | Per-user OAuth flow, browser redirect |
| Server-to-server (no user) | oauth2_client_credentials | Machine identity |
| Have existing tokens to import | oauth2_token | Manual token management |
| Microsoft/Azure services | azure_ad | Tenant-scoped, auto-refresh |
| No auth needed | none | Public APIs |

### Tool Sequence: Create Auth Profile
1. auth_ops(action: "list") — check existing profiles
2. Determine auth type based on integration requirements
3. For each required secret field:
   - call collect_secret with flowId for secure collection
4. auth_ops(action: "create", { profileName, authType, config, flowId })
5. auth_ops(action: "validate", { profileId }) — verify credentials work
6. Wire to tool: tools_ops(action: "update", { toolId, authProfileId })

### Before Deleting
- auth_ops(action: "read", { profileId }) — check if inherited (workspace-level can't be deleted)
- Check consumers: what tools/connections use this profile?
- Warn user: deleting breaks dependent tools
- auth_ops(action: "delete", { profileId, confirmed: true })

### Common Pitfalls
- oauth2_app requires browser redirect — can't complete entirely from Arch
- Workspace-level profiles are read-only at project level
- client_credentials tokens expire — platform auto-refreshes but initial validation may fail if tokenUrl is wrong
- api_key placement matters: header vs query parameter

### When to Use search_docs
- Provider-specific OAuth scopes and URLs
- Azure AD tenant configuration details
- Token refresh error troubleshooting
`;

export const CONNECTION_OPERATIONS_CARD = `## Connections — Operational Guide

### Decision Tree: Connection Type
| Need | Connection Type | Notes |
|------|----------------|-------|
| Agent transfer to contact center | Agent Desktop (Five9, Kore, Genesys) | Specialized adapters |
| CRM data access | CRM connector (Salesforce, HubSpot) | OAuth typically required |
| Document sync to KB | Storage connector (Google Drive, SharePoint) | Used by KB connectors |
| Ticket creation/updates | Ticketing (Zendesk, ServiceNow, Jira) | Bidirectional sync |
| Custom webhook integration | Direct tool with auth profile | Not a "connection" per se |

### Tool Sequence: Create Connection
1. connection_ops(action: "catalog") — show available connector types
2. Ask user which connector + purpose
3. connection_ops(action: "create", { connectorType, name, credentials })
4. connection_ops(action: "test", { connectionId }) — verify it works
5. Wire to tools or KB: tools_ops/kb_connector reference connectionId

### Error Recovery
- expired: OAuth token expired → guide user to re-authorize
- error: check credentials, test again
- If test fails repeatedly → search_docs for provider-specific troubleshooting

### Cross-Feature Wiring
- Connections provide auth for tools (tool references connection)
- Connections provide sync for KB connectors (SharePoint → KB ingest)
- Agent Desktop connections enable agent transfer feature

### When to Use search_docs
- Provider-specific API rate limits
- OAuth scope requirements per connector
- Troubleshooting specific error codes
`;

export const KB_OPERATIONS_CARD = `## Knowledge Bases — Operational Guide

### Decision Tree: Which Source Type?
| Content Type | Recommended Source | Notes |
|--------------|-------------------|-------|
| Static documents (PDF, DOCX) | File upload | One-time or periodic manual upload |
| Website content | Web crawl | Scheduled, automatic updates |
| Enterprise wiki (Confluence) | Enterprise connector | Real-time sync, permissions |
| Cloud storage (SharePoint, Drive) | Enterprise connector | Folder-based sync |
| Database records | Database connector | SQL query-based extraction |
| API responses | Custom ingest via API | Programmatic ingestion |

### Tool Sequence: Set Up KB
1. kb_manage(action: "create", { name, description }) — create KB
2. Choose source strategy based on content type
3. kb_ingest(action: "add_source", { indexId, sourceType, config }) — add source
4. Wait for ingestion to complete (check kb_health)
5. kb_search(action: "test", { query }) — verify retrieval quality
6. Wire to agent: add KB tool binding in agent TOOLS section

### Embedding Model Selection
- Default model works for most English content
- Switch to multilingual model for non-English corpora
- Custom models for domain-specific terminology (medical, legal)
- Change BEFORE ingesting — re-embedding is expensive

### Search Strategy by Content Type
- FAQ/support articles → hybrid search (best for natural questions)
- Technical docs → semantic search (concept matching)
- Product catalogs → structured list (field filtering)
- Analytics data → aggregation queries

### When to Use search_docs
- Specific chunking strategy configuration
- Connector-specific sync settings
- Vocabulary and synonym management details
- Knowledge graph configuration
`;

export const EXTERNAL_AGENT_OPERATIONS_CARD = `## External Agents — Operational Guide

### Decision Tree: A2A vs REST
| Scenario | Protocol | Notes |
|----------|----------|-------|
| Partner provides A2A-compatible agent | a2a | Standard protocol, agent card discovery |
| Custom internal service | rest | Simple request/response |
| Need streaming responses | a2a | A2A supports streaming |
| Legacy webhook service | rest | Adapt to REST agent format |

### Tool Sequence: Register External Agent
1. external_agent_ops(action: "list") — check existing registrations
2. Ask user for: endpoint URL, protocol, auth requirements
3. external_agent_ops(action: "register", { name, url, protocol, authConfig })
4. external_agent_ops(action: "test", { agentId }) — verify connectivity
5. Wire into topology: add ESCALATE or HANDOFF to external agent in ABL

### A2A Channel Binding
After registration, create an A2A channel to route traffic:
1. Register external agent (above)
2. channel_ops(action: "create", { channelType: "a2a", externalAgentId })
3. Bind to environment

### Health Monitoring
- test-connection runs: GET /.well-known/agent.json (A2A) or health endpoint (REST)
- Status: connected, failed, untested
- Recommend periodic re-testing if agent is critical path

### When to Use search_docs
- A2A protocol specification details
- Agent card schema requirements
- Task lifecycle state machine
`;

export const PROJECT_LIFECYCLE_CARD = `## Project Lifecycle — What to Do Next

### Project Maturity Stages
| Stage | Indicators | Recommended Actions |
|-------|-----------|---------------------|
| Empty | No agents | Start with Arch wizard or create first agent |
| Building | Agents exist, no tests | Add tools, configure KB, write test scenarios |
| Testing | Tests exist, no deployment | Run eval batches, fix issues, prepare for deploy |
| Deployed (dev) | Dev deployment active | Test with real channels, validate integrations |
| Deployed (prod) | Production deployment | Monitor metrics, set up alerts, iterate |

### Resource Checklist
- [ ] Agents: at least one agent configured and compiling
- [ ] Tools: HTTP/function/KB tools wired to agents
- [ ] Knowledge Base: if agent needs domain knowledge
- [ ] Auth Profiles: for any tools requiring authentication
- [ ] Test Scenarios: at least 5 eval scenarios per agent
- [ ] Deployment: dev environment deployed
- [ ] Channels: at least one channel bound and tested
- [ ] Monitoring: traces accessible, error alerts configured

### Common Anti-Patterns
- Deploying to production without running evals
- No error handlers in agents (runtime failures go unhandled)
- Missing guardrails (agent can discuss anything)
- No channel testing before going live
- Hardcoded values instead of environment variables

### When to Use search_docs
- Specific checklist items for a particular channel or integration
- Best practices for a particular industry vertical
- Advanced monitoring and alerting configuration
`;
