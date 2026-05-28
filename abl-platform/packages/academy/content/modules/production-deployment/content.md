# Production Deployment

> **Estimated time**: 35 minutes | **Prerequisites**: Basic agent building, familiarity with ABL project structure

## Learning Objectives

After completing this module, you will be able to:

- Publish agents through the deployment lifecycle (active, draining, retired)
- Configure environment variables that resolve at session start
- Set up GitOps auto-deploy workflows for continuous delivery
- Connect agents to web, Slack, WhatsApp, and voice channels
- Understand identity continuity tiers across channels

## The Deployment Lifecycle

Getting an agent from "works in testing" to "serves live traffic" requires understanding Agent Platform's deployment model. A deployment is a versioned snapshot of your agents bound to a specific environment.

### Creating a Deployment

Before deploying, create versioned snapshots of your agents. Versions capture the compiled ABL definition at a point in time -- versions with compilation errors are rejected.

Deploy through Studio or the API:

```bash
curl -X POST /api/projects/:projectId/deployments \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "environment": "production",
    "entryAgentName": "Airlines_Supervisor",
    "agentVersionManifest": {
      "Airlines_Supervisor": "1.0.0",
      "Flight_Search": "1.0.0"
    },
    "label": "v1.0 - Initial release"
  }'
```

Use `"auto"` as the version value to auto-create a version from the current working copy.

### Deployment Status Transitions

Every deployment moves through three statuses:

| Status         | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| **`active`**   | Receiving new sessions and serving traffic            |
| **`draining`** | No new sessions; existing sessions complete naturally |
| **`retired`**  | Fully decommissioned, no traffic                      |

> **Key Concept**: When you create a new deployment, the platform automatically sets the previous active deployment to **`draining`** status. Draining means the old deployment stops accepting new sessions, but any in-progress conversations continue until they complete naturally. Only one deployment per environment can be `active` at a time. This graceful transition prevents abruptly cutting off users mid-conversation.

This is critical for production operations. If a customer is in the middle of a payment flow when you deploy v2, they continue on v1 until their session ends. New customers get v2 immediately.

### Rollback

If a deployment causes issues, roll back instantly:

1. Navigate to **Deployments** in Studio
2. Find the problematic deployment
3. Click **Rollback**

This retires the current deployment and reactivates the previous one. The same is available via API.

## Environment Variables

Environment variables let you change agent behavior per environment without modifying ABL code. This is how you manage different API endpoints, feature flags, and configuration between dev, staging, and production.

### Defining and Referencing Variables

Reference environment variables in your agent definitions with the `{{env.KEY}}` syntax:

```abl
TOOLS:
  process_payment:
    description: "Process a payment"
    type: http
    endpoint: "{{env.API_BASE_URL}}/payments"
    auth: bearer
```

Configure different values per environment in **Project Settings > Environment Variables**:

```
Environment: production
+------------------+-------------------------------+--------+
| Key              | Value                         | Secret |
+------------------+-------------------------------+--------+
| API_BASE_URL     | https://api.example.com       | No     |
| PAYMENT_API_KEY  | ********                      | Yes    |
| FEATURE_NEW_FLOW | true                          | No     |
+------------------+-------------------------------+--------+
```

> **Key Concept**: Environment variables using the `{{env.KEY}}` syntax are **resolved at session start**. This means existing sessions use the values from when they were created. If you update `API_BASE_URL` in production, only new sessions pick up the change -- conversations already in progress continue with the old value. This provides stability but means variable changes are not instant for active users.

### Feature Flags via Environment Variables

Use environment variables as lightweight feature flags:

```abl
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
```

Set `FEATURE_NEW_FLOW=true` in staging to test, then flip it in production when ready. Remember: only new sessions see the change.

### Secrets

Toggle **Secret** when adding sensitive values. Secrets are write-only after saving -- you can update or delete them but never view the stored value again.

## Environments

Agent Platform supports three built-in environments per project:

| Environment  | Purpose                                                      |
| ------------ | ------------------------------------------------------------ |
| `dev`        | Active development and Studio testing                        |
| `staging`    | Pre-production validation with production-like configuration |
| `production` | Live traffic from end users via channels and APIs            |

Each environment has its own active deployment, environment variables, channel bindings, and model overrides. You can promote a staging deployment to production:

```bash
curl -X POST /api/projects/:projectId/deployments/:stagingDeploymentId/promote \
  -d '{"targetEnvironment": "production"}'
```

## Git Integration and GitOps Auto-Deploy

For teams that manage agent definitions as code, Agent Platform supports full Git integration with automatic deployment pipelines.

### Connecting a Repository

Connect to GitHub, GitLab, Bitbucket, or any Git provider via personal access tokens, OAuth, or SSH keys. Configure the repository URL, default branch, and sync path.

### Auto-Deploy from Git

> **Key Concept**: **GitOps auto-deploy** automatically deploys when code is pushed to a specific branch. Configure it under Git Integration settings: select a branch (e.g., `main`) and a target environment (e.g., `production`). When a push lands on the configured branch, the platform pulls the latest files, validates and compiles all agents, creates auto-versioned snapshots, and creates a new deployment in the target environment.

A common GitOps workflow maps branches to environments:

| Branch    | Auto-deploys to |
| --------- | --------------- |
| `develop` | `dev`           |
| `staging` | `staging`       |
| `main`    | `production`    |

This means a merge to `main` automatically creates a production deployment -- no manual steps required. The auto-deploy aborts if any agent has compilation errors, protecting production from broken code.

### Auto-Sync and Conflict Resolution

Enable auto-sync to keep Studio and your repository in sync. Choose a conflict strategy:

| Strategy      | Behavior                                          |
| ------------- | ------------------------------------------------- |
| `manual`      | Pause on conflicts and wait for manual resolution |
| `local_wins`  | Studio changes overwrite repository changes       |
| `remote_wins` | Repository changes overwrite Studio changes       |

## Connecting Channels

Channels connect your deployed agents to the platforms where users interact. The key insight: your agent definition works across all channels without modification -- channel adapters handle protocol-specific details.

### Web Chat Widget

Deploy a chat widget on any website using the ABL Web SDK:

```html
<script src="https://your-platform/sdk/widget.js"></script>
<script>
  ABL.init({
    apiKey: 'your-api-key',
    projectId: 'your-project-id',
    position: 'bottom-right',
    theme: { primaryColor: '#4F46E5' },
  });
</script>
```

The widget supports chat, optional voice input, domain restrictions for security, and passing authenticated user context.

### Slack Integration

Setting up Slack involves creating a Slack app, configuring OAuth scopes, and connecting the webhook:

1. Create a Slack app at api.slack.com/apps with bot scopes (`chat:write`, `app_mentions:read`, `im:read`, `im:write`)
2. Register the credentials with Agent Platform to get a `webhookUrl`
3. Configure Slack Event Subscriptions

> **Key Concept**: The `webhookUrl` returned when you create a Slack channel connection is used as the **Event Subscriptions Request URL** in your Slack app settings. Paste this URL under Event Subscriptions, enable events, and subscribe to `message.im` and `app_mention` bot events. Slack sends a verification challenge to this URL, and the platform responds automatically.

The Slack adapter supports threaded replies (keeping channels clean), slash commands, and interactive components (buttons, select menus).

### WhatsApp Integration

Connect via Meta's Cloud API or third-party providers (Infobip, Twilio). The WhatsApp adapter automatically handles receiving images, documents, audio, and video. You can send interactive WhatsApp messages using the `whatsapp` field in rich content blocks.

### Voice Channels

The platform supports voice through Jambonz (SIP gateway), Twilio, AudioCodes, and BYOC SIP. Use `VOICE` blocks in your agent for voice-optimized output:

```abl
RESPOND: "Your account balance is ${{balance}}."
  VOICE:
    SSML: |
      <speak>
        Your account balance is
        <say-as interpret-as="currency">USD{{balance}}</say-as>.
      </speak>
```

### Email Channel

The email channel enables agents to handle inbound emails and send structured email responses. Configure the email channel with an SMTP/IMAP connection or an email provider integration:

- **Inbound emails** -- The platform monitors a configured mailbox. When a new email arrives, it creates a session with the email subject as context and the body as the first message.
- **Threaded conversations** -- Reply chains are tracked as a single session. The agent can handle multi-turn email conversations with full context.
- **Rich email responses** -- Agents can send HTML-formatted emails using the `email` field in `RICH_CONTENT` blocks, including headers, tables, and inline images.
- **Attachments** -- Inbound email attachments are processed through the document ingestion pipeline and made available to the agent as context.

Email is particularly useful for B2B workflows where customers prefer asynchronous communication -- support tickets, order confirmations, and follow-up communications.

### Webhooks & Event Notifications

Beyond channels for user interaction, Agent Platform supports outbound **webhooks** for event-driven integration with external systems.

#### Configuring Webhooks

Register webhook endpoints under **Project Settings > Webhooks**:

```bash
curl -X POST /api/projects/:projectId/webhooks \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "url": "https://your-system.com/hooks/agent-events",
    "events": ["session.completed", "session.escalated", "deployment.created"],
    "secret": "your-webhook-secret"
  }'
```

#### Supported Events

| Event                    | Fires When                           |
| ------------------------ | ------------------------------------ |
| `session.completed`      | A conversation session ends normally |
| `session.escalated`      | An agent escalates to a human        |
| `session.timeout`        | A session times out from inactivity  |
| `deployment.created`     | A new deployment is created          |
| `deployment.rolled_back` | A deployment is rolled back          |
| `eval.completed`         | An evaluation run finishes           |
| `alert.triggered`        | An alert rule condition is met       |

#### Webhook Payload

Each webhook delivery includes a signed payload with the event type, timestamp, and event-specific data:

```json
{
  "event": "session.completed",
  "timestamp": "2026-03-30T14:22:00Z",
  "data": {
    "sessionId": "sess-abc123",
    "agentName": "Supervisor",
    "turnCount": 5,
    "containment": true,
    "duration": 120
  },
  "signature": "sha256=..."
}
```

Verify the `signature` header using your webhook secret to ensure the payload was sent by Agent Platform and not a third party.

### Rich Content Across Channels

Use `RICH_CONTENT` blocks to provide channel-specific formatting:

```abl
RESPOND: "Your order status"
  RICH_CONTENT:
    markdown: |
      ## Order #{{order_id}}
      **Status**: {{status}}
    slack: |
      {"blocks": [{"type": "header", "text": {"type": "plain_text", "text": "Order Status"}}]}
    whatsapp: |
      {"type": "interactive", "interactive": {"type": "button", ...}}
```

The runtime selects the format matching the connected channel, falling back to plain text if no match exists.

## Channel Identity Continuity

When users interact across channels -- starting on web chat, then calling in -- the platform preserves their identity using a tiered model.

### Identity Tiers

| Tier   | Strength | Description                                                     | Example                                          |
| ------ | -------- | --------------------------------------------------------------- | ------------------------------------------------ |
| **T0** | None     | Anonymous, unverified                                           | New visitor with no cookies                      |
| **T1** | Weak     | Recognized but not cryptographically verified; could be spoofed | Caller ID match, browser cookie                  |
| **T2** | Strong   | Cryptographically verified with high confidence                 | OAuth token, OTP confirmation, HMAC-signed token |

> **Key Concept**: Identity tier **T1 (weak)** applies to channel artifacts like caller ID. When a phone call arrives, the platform recognizes the caller by matching their phone number against known identities -- but this is a "weak" signal because caller ID can be spoofed. T1 is sufficient for personalizing greetings ("Welcome back, Jane!") but should not be relied upon for sensitive operations like account changes. For those, require T2 (strong) verification through OAuth, OTP, or similar cryptographic methods.

Configure verification strength per channel connection:

```bash
curl -X PATCH /api/projects/$PROJECT_ID/channel-connections/$CONNECTION_ID \
  -d '{"config": {"identityVerification": {"providerVerificationStrength": "weak"}}}'
```

Use identity tiers in your agent logic:

```abl
FLOW:
  entry:
    REASONING: false
    - IF: caller.identityTier >= 1
      RESPOND: "Welcome back, {{caller.name}}!"
      THEN: handle_request
    - ELSE:
      RESPOND: "Hello! I'll need to verify your identity."
      THEN: verify_identity
```

## Monitoring and Alerts

### Performance Metrics

Track per-session metrics including response latency, LLM call count, tool call count, token usage, turn count, handoff count, and completion status.

### Setting Up Alerts

Configure automated notifications under **Operate > Alerts** for latency spikes, error rate thresholds, token budget limits, and session abandonment rates.

## Project Export and Import

Export projects as portable file bundles for backup, migration, or sharing:

```bash
# Export
curl -X GET /api/projects/:projectId/project-io/export \
  -H "Authorization: Bearer $TOKEN"

# Import with preview
curl -X POST /api/projects/:projectId/project-io/import/preview \
  -d '{"files": {"agents/supervisor.agent.abl": "..."}}'
```

Importing does not overwrite existing agents -- conflicts are flagged for resolution.

## Key Takeaways

- New deployments automatically set previous deployments to **draining** status, allowing in-progress sessions to complete gracefully
- `{{env.KEY}}` environment variables are resolved at **session start** -- existing sessions keep their original values
- **GitOps auto-deploy** triggers automatic deployments when code is pushed to a configured branch, with compilation validation as a safety gate
- Identity tier **T1 (weak)** is based on channel artifacts like caller ID -- sufficient for personalization but not for sensitive operations
- The Slack `webhookUrl` is configured as the **Event Subscriptions Request URL** in your Slack app settings

## What's Next

Explore the **Reuse & Integration** module to learn about sharing agent functionality across projects with versioned, immutable modules and integrating with the platform API. See the **Studio Mastery** module for the visual deployment workflow.
