// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: guides/channels.mdx
// Regenerate: pnpm abl:docs:generate

export const CHANNELS_OVERVIEW_CARD = `## Channels — Types, Categories & Capabilities

## Deploy on Web
- Deploy your agent on a website using the ABL Web SDK to embed a chat widget that connects to your deployed agent.
### Create an SDK Channel
- Create a web SDK channel for your project.
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/sdk-channels \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Website Chat",
    "channelType": "web",
    "config": {
      "mode": "chat",
      "position": "bottom-right",
      "welcomeMessage": "Hi! How can I help you today?",
      "placeholderText": "Type a message...",
      "chatEnabled": true,
      "voiceEnabled": false,
      "theme": {
        "primaryColor": "#4F46E5",
        "fontFamily": "Inter, sans-serif"
      }
    }
  }'
\`\`\`
The response includes a \`publicApiKeyId\`. Generate an embed token for the widget.
### Generate an Embed Token
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/sdk-channels/\$CHANNEL_ID/token \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "ttlSeconds": 2592000
  }'
\`\`\`
The response includes the \`token\` and \`apiKey\` you embed in your website.
### Add the Widget to Your Website
Add the SDK script tag and initialization code to your HTML page.
\`\`\`html
<!doctype html>
<html>
  <head>
    <title>My Website</title>
  </head>
  <body>
    <!-- Your page content -->

    <!-- ABL Chat Widget -->
    <script src="https://your-platform/sdk/widget.js"></script>
    <script>
      ABL.init({
        apiKey: 'your-api-key',
        projectId: 'your-project-id',
        position: 'bottom-right',
        theme: {
          primaryColor: '#4F46E5',
        },
      });
    </script>
  </body>
</html>
\`\`\`
- The widget renders a chat button in the configured position.
### Voice-Enabled Widget
Enable voice input alongside chat.
\`\`\`typescript
ABL.init({
  apiKey: 'your-api-key',
  projectId: 'your-project-id',
  chatEnabled: true,
  voiceEnabled: true,
  voiceConfig: {
    language: 'en-US',
    autoDetectLanguage: true,
  },
});
\`\`\`
### Restrict to Specific Domains
Lock the SDK key to specific origins to prevent unauthorized embedding.
\`\`\`bash
curl -X PATCH https://your-platform/api/projects/\$PROJECT_ID/sdk-channels/\$CHANNEL_ID \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "config": {
      "allowedOrigins": [
        "https://www.example.com",
        "https://app.example.com"
      ]
    }
  }'
\`\`\`
Requests from origins not in the list receive a \`403 Forbidden\` response.
### Pass User Context
Identify authenticated users by passing context at initialization.
\`\`\`typescript
ABL.init({
  apiKey: 'your-api-key',
  projectId: 'your-project-id',
  user: {
    id: 'user-123',
    name: 'Jane Smith',
    email: 'jane@example.com',
    metadata: {
      plan: 'premium',
      accountAge: 365,
    },
  },
});
\`\`\`
User context is available to your agent via session variables and persistent memory lookups.
### Target a Specific Deployment
Direct the SDK to use a specific deployment (e.g., staging vs. production).
\`\`\`bash
curl -X PATCH https://your-platform/api/projects/\$PROJECT_ID/sdk-channels/\$CHANNEL_ID \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "deploymentId": "deploy-abc123",
    "environment": "production"
  }'
\`\`\`
### Troubleshooting
- **Widget does not appear:** Verify the script URL is correct and the \`apiKey\` is valid. Check the browser console for errors.
- **"Invalid or expired API key" error:** The API key may have been rotated or the SDK channel deactivated. Generate a new token.
- **CORS errors:** Add your website's origin to the \`allowedOrigins\` list in the SDK channel configuration.
- **Widget loads but no response from agent:** Verify that a deployment is active for the project. The SDK channel must be linked to an active deployment.
## Set Up Slack
- Connect your agent to Slack so users can interact with it directly in Slack channels and direct messages.
### Create a Slack App
- 1.
2. Name your app and select the workspace.
3. Under **OAuth & Permissions**, add these bot token scopes:
   - \`chat:write\` -- send messages
   - \`app_mentions:read\` -- respond to @mentions
   - \`im:read\`, \`im:write\` -- direct messages
   - \`files:read\` -- read file attachments (if your agent handles attachments)
4. Install the app to your workspace. Copy the **Bot User OAuth Token** (\`xoxb-...\`).
5. Under **Basic Information**, copy the **Signing Secret**.
### Create a Channel Connection
Register the Slack app credentials with the Agent Platform 2.0.
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/channel-connections \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "channelType": "slack",
    "name": "Production Slack",
    "credentials": {
      "bot_token": "xoxb-your-bot-token",
      "signing_secret": "your-signing-secret"
    },
    "environment": "production"
  }'
\`\`\`
The response includes the \`webhookUrl\`. Copy it for the next step.
### Configure the Slack Webhook
1. In your Slack app settings, go to **Event Subscriptions**.
2. Enable events and paste the \`webhookUrl\` from the channel connection response.
3. Slack sends a verification challenge. The platform responds automatically.
4. Under **Subscribe to bot events**, add:
   - \`message.im\` -- direct messages to the bot
   - \`app_mention\` -- @mentions in channels
5. Save changes.
### Slack with Threaded Replies
- The platform supports threaded conversations in Slack.
### Slack Slash Commands
Register a custom slash command that routes to your agent.
1. In your Slack app settings, go to **Slash Commands** and create a new command (e.g., \`/ask\`).
- 2.
- 3.
### Slack with Interactive Components
If your agent uses actions (buttons, select menus), enable **Interactivity** in your Slack app:
1. Go to **Interactivity & Shortcuts** and toggle on.
2. Set the Request URL to the same webhook URL used for events.
3. Interactive payloads (button clicks, menu selections) are automatically routed to your agent.
### Multi-Workspace Slack App
- For distributing your agent across multiple Slack workspaces, use the generic webhook URL (without a connection identifier).
\`\`\`
Webhook URL: https://your-platform/api/v1/channels/slack/webhook
\`\`\`
Create a separate channel connection for each workspace that installs the app.
### Troubleshooting
- **"Channel not configured for this workspace" error:** The channel connection's external identifier does not match the Slack workspace. Verify the \`team_id:app_id\` matches your Slack app installation.
- **Bot does not respond to messages:** Check that the Event Subscriptions URL verification succeeded (green checkmark in Slack). Verify the \`bot_token\` scope includes \`chat:write\`.
- **Signature verification fails:** The \`signing_secret\` in the channel connection must match the Signing Secret from the Slack app's Basic Information page. Secrets are case-sensitive.
- **Duplicate responses:** Slack requires a response within 3 seconds. The platform queues messages and responds asynchronously. If your Slack app's retry policy re-sends events, the platform deduplicates using event IDs.
## Set Up WhatsApp
Connect your agent to WhatsApp so users can interact with it via WhatsApp messages.
### Configure a WhatsApp Business API Account
- Before connecting to the platform, you need a WhatsApp Business API provider account.
**Meta Cloud API setup:**
- 1.
- 2.
3. Generate a permanent **System User Access Token** with \`whatsapp_business_messaging\` permission.
4. Under **Configuration**, note the **App Secret** for webhook signature verification.
### Create a Channel Connection
Register the WhatsApp credentials with the Agent Platform 2.0.
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/channel-connections \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "channelType": "whatsapp",
    "name": "Production WhatsApp",
    "credentials": {
      "access_token": "your-system-user-access-token",
      "app_secret": "your-app-secret",
      "verify_token": "a-random-string-you-choose"
    },
    "config": {
      "phoneNumberId": "your-phone-number-id"
    },
    "environment": "production"
  }'
\`\`\`
The response includes the \`webhookUrl\`.
### Configure the Meta Webhook
1. In your Meta App settings, go to **WhatsApp > Configuration**.
2. Under **Webhook**, click **Edit** and paste the \`webhookUrl\`.
3. Enter the same \`verify_token\` you used when creating the channel connection.
4. Click **Verify and Save**. Meta sends a GET request to verify the webhook.
5. Under **Webhook fields**, subscribe to \`messages\`.
### Infobip Provider
For WhatsApp via Infobip, use the provider-specific configuration.
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/channel-connections \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "channelType": "whatsapp",
    "name": "Infobip WhatsApp",
    "credentials": {
      "access_token": "your-infobip-api-key",
      "app_secret": "your-webhook-secret",
      "verify_token": "unused-for-infobip"
    },
    "config": {
      "provider": "infobip",
      "phoneNumberId": "your-sender-number"
    }
  }'
\`\`\`
Set the Infobip webhook URL to:
\`\`\`
https://your-platform/api/v1/channels/whatsapp/infobip/webhook
\`\`\`
### WhatsApp with Media Support
- The WhatsApp adapter supports receiving images, documents, audio, and video from users.
### WhatsApp Interactive Messages
- Your agent can send interactive WhatsApp messages (buttons, lists) using the \`whatsapp\` field in rich content.
\`\`\`abl
FLOW:
  offer_options:
    REASONING: false
    RESPOND: "How can I help you today?"
      RICH_CONTENT:
        whatsapp: |
          {
            "type": "interactive",
            "interactive": {
              "type": "list",`;
