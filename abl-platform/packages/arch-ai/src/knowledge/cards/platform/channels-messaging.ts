// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: guides/channels.mdx
// Regenerate: pnpm abl:docs:generate

export const CHANNELS_MESSAGING_CARD = `## Messaging Channels — Slack, WhatsApp, Teams, Telegram

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
              "type": "list",
              "body": {"text": "Choose a topic:"},
              "action": {
                "button": "Select",
                "sections": [
                  {
                    "title": "Support",
                    "rows": [
                      {"id": "billing", "title": "Billing"},
                      {"id": "technical", "title": "Technical Issue"}
                    ]
                  }
                ]
              }
            }
          }
    THEN: handle_selection
\`\`\`
### Troubleshooting
- **Webhook verification fails:** The \`verify_token\` in the channel connection must match the value entered in the Meta webhook configuration. It is a plain string you choose, not a Meta-generated secret.
- **Messages not arriving:** Verify that you subscribed to the \`messages\` webhook field in Meta's configuration. Also check that the phone number is registered and has an active WhatsApp Business account.
- **Signature verification fails on inbound messages:** The \`app_secret\` must be the Meta App Secret (from Basic Settings), not the system user access token.
- **Media messages not processed:** Large media files may timeout during download. Check the attachment processing logs for the session.
## Rich Content
- Use rich content to send formatted responses -- Markdown, Adaptive Cards, Slack blocks, carousels, and interactive elements -- that adapt to each channel's capabilities.
### Add Rich Content to a Response
Use the \`RICH_CONTENT\` block alongside \`RESPOND\` to provide channel-specific formatting.
\`\`\`abl
FLOW:
  show_results:
    REASONING: false
    RESPOND: "Here are your search results"
      RICH_CONTENT:
        markdown: |
          ## Search Results

          | Hotel | Price | Rating |
          |-------|-------|--------|
          {{#each hotels}}
          | {{name}} | \${{price}} | {{rating}} stars |
          {{/each}}
\`\`\`
- The runtime selects the format that matches the connected channel.
### Adaptive Cards (Microsoft Teams)
Send rich interactive cards on Teams using the Microsoft Adaptive Cards format.
\`\`\`abl
RESPOND: "Your booking summary"
  RICH_CONTENT:
    adaptiveCard: |
      {
        "type": "AdaptiveCard",
        "version": "1.5",
        "body": [
          {"type": "TextBlock", "text": "Booking Confirmed", "size": "large", "weight": "bolder"},
          {"type": "FactSet", "facts": [
            {"title": "Hotel", "value": "{{hotel_name}}"},
            {"title": "Dates", "value": "{{checkin}} - {{checkout}}"},
            {"title": "Total", "value": "\${{total}}"}
          ]}
        ]
      }
\`\`\`
### Slack Block Kit
Send formatted messages with Slack blocks.
\`\`\`abl
RESPOND: "Your order status"
  RICH_CONTENT:
    slack: |
      {
        "blocks": [
          {"type": "header", "text": {"type": "plain_text", "text": "Order Status"}},
          {"type": "section", "fields": [
            {"type": "mrkdwn", "text": "*Order:* #{{order_id}}"},
            {"type": "mrkdwn", "text": "*Status:* {{status}}"}
          ]},
          {"type": "divider"},
          {"type": "section", "text": {"type": "mrkdwn", "text": "Estimated delivery: {{delivery_date}}"}}
        ]
      }
\`\`\`
### WhatsApp Interactive Messages
Send interactive list or button messages on WhatsApp.
\`\`\`abl
RESPOND: "Select an option"
  RICH_CONTENT:
    whatsapp: |
      {
        "type": "interactive",
        "interactive": {
          "type": "button",
          "body": {"text": "How would you like to proceed?"},
          "action": {
            "buttons": [
              {"type": "reply", "reply": {"id": "modify", "title": "Modify Booking"}},
              {"type": "reply", "reply": {"id": "cancel", "title": "Cancel Booking"}},
              {"type": "reply", "reply": {"id": "info", "title": "More Info"}}
            ]
          }
        }
      }
\`\`\`
### Carousel of Cards
Send a scrollable carousel of cards across supported channels.`;
