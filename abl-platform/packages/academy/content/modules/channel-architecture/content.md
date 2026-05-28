# Channel Architecture

> **Estimated time**: 35 minutes | **Prerequisites**: Basic understanding of webhooks, REST APIs, and messaging platforms

## Learning Objectives

After completing this module, you will be able to:

- Explain how the channel adapter pattern normalizes messages across 20+ platforms
- Compare the capabilities and limitations of different channel types (Teams, WhatsApp, Slack)
- Describe the 5 methods every ChannelAdapter implements
- Understand the message processing pipeline from webhook ingress to BullMQ enqueueing
- Configure identity tiers for cross-channel caller recognition

## The Channel Adapter Pattern

Agent Platform supports over 20 channels -- Slack, Microsoft Teams, WhatsApp, voice gateways, web SDK, and more. The core design challenge is: how do you make a single agent definition work across all of them without rewriting agent logic for each platform?

The answer is the **channel adapter pattern**. Every channel has a dedicated adapter that acts as a translator between the external platform's native protocol and the platform's internal message format. Your agent definition stays the same; the adapter handles all the protocol-specific details.

```
External platform --webhook/ws--> Channel Adapter --normalize--> Inbound Queue
                                                                      |
                                                          Agent Runtime executes
                                                                      |
External platform <--send------ Channel Adapter <--transform-- Outbound Queue
```

This architecture means you write your agent once and deploy it everywhere. A booking confirmation agent works identically whether the user is on Slack, WhatsApp, or a voice call -- the adapter translates the interaction for each platform.

## The 5 ChannelAdapter Methods

Every channel adapter implements the `ChannelAdapter` interface with five core methods. Understanding these methods helps you reason about what happens at each stage of message processing.

| Method                      | Purpose                                                                      | Example                                                                           |
| --------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **`verifyRequest()`**       | Validates inbound request signatures (HMAC, JWT, token)                      | Slack sends an HMAC signature; the adapter verifies it against the signing secret |
| **`parseIncoming()`**       | Converts platform-specific payload into a `NormalizedIncomingMessage`        | Extracts text, sender ID, and thread info from a WhatsApp webhook payload         |
| **`sendResponse()`**        | Delivers the agent's response through the channel                            | Posts a message back to a Slack channel using the Bot Token                       |
| **`transformOutput()`**     | Converts plain text and interactive actions into the channel's native format | Transforms ABL `ACTION_SET` buttons into Slack Block Kit buttons                  |
| **`sendTypingIndicator()`** | Sends a "typing" signal on channels that support it                          | Shows "bot is typing..." in Microsoft Teams while the agent processes             |

> **Key Concept**: The `sendTypingIndicator()` method is one of the 5 core adapter methods. Not all channels support it -- voice channels and SMS, for example, have no concept of a typing indicator. The adapter gracefully no-ops on unsupported channels.

## The Message Processing Pipeline

When a message arrives from any channel, it flows through a well-defined pipeline before the agent ever sees it. Understanding this pipeline is essential for debugging channel issues.

### Step-by-step processing

1. **Inbound webhook** -- The external platform sends a raw HTTP payload (or WebSocket message) to the adapter's endpoint.

2. **Verification** -- The adapter calls `verifyRequest()` to validate the signature. For Slack, this is HMAC verification using the signing secret. For Teams, it is JWT validation. If verification fails, the request is rejected immediately.

3. **Filtering** -- The adapter skips messages that should not be processed: bot-generated messages (to avoid echo loops), irrelevant event subtypes, and duplicate events (using idempotency keys).

4. **Connection resolution** -- The adapter maps the external identifier (like Slack's `team_id:app_id`) to a specific tenant, project, and agent in the platform.

5. **Normalization** -- The adapter calls `parseIncoming()` to convert the raw payload into a `NormalizedIncomingMessage` with standardized fields:

| Field                | Type   | Description                                                |
| -------------------- | ------ | ---------------------------------------------------------- |
| `externalMessageId`  | string | Unique message ID from the external platform               |
| `externalSessionKey` | string | Conversation or thread identifier                          |
| `text`               | string | Message text content                                       |
| `metadata`           | object | Channel-specific metadata                                  |
| `timestamp`          | Date   | Original message timestamp                                 |
| `actionEvent`        | object | Interactive callback data (button clicks, menu selections) |

6. **Enqueue** -- After normalization, the message is added to the **BullMQ inbound queue** with idempotency keys. This is a critical design decision: the adapter does not process the message synchronously. Instead, it enqueues the job and returns a response to the external platform quickly (within Slack's 3-second requirement, for example).

7. **Processing** -- The BullMQ inbound worker picks up the job, creates or resumes a session, and runs the agent.

8. **Delivery** -- The agent's response is transformed by `transformOutput()` into the channel's native format and sent via `sendResponse()`.

> **Key Concept**: BullMQ enqueueing after normalization is the critical architectural boundary. It decouples the fast webhook acknowledgment from the potentially slow agent execution. This is why Slack does not time out even when your agent takes 10 seconds to respond -- the webhook was acknowledged in milliseconds, and the response is delivered asynchronously through the outbound queue.

## Channel Capabilities Comparison

Not all channels are created equal. Understanding the capabilities and limitations of each channel helps you design agents that work well everywhere.

### The Channel Matrix

| Channel             | Threading | Streaming | Rich Output                 | Media |
| ------------------- | --------- | --------- | --------------------------- | ----- |
| **Slack**           | Yes       | Yes       | Block Kit                   | Yes   |
| **Microsoft Teams** | Yes       | Yes       | Adaptive Cards              | Yes   |
| **WhatsApp**        | No        | No        | Interactive (buttons/lists) | Yes   |
| **Telegram**        | No        | Yes       | Keyboards                   | Yes   |
| **Web Chat (SDK)**  | No        | Yes       | Full (Markdown, HTML, etc.) | Yes   |
| **Voice (Twilio)**  | No        | Yes       | No (audio only)             | No    |

### Microsoft Teams: Streaming and Threading

Teams is one of the most capable channels. It supports:

- **Streaming** -- Responses can be streamed token-by-token, showing the agent "typing" its response in real time.
- **Threading** -- Conversations can happen in threads, keeping channels organized. When the bot is mentioned in a channel, it responds in a thread by default.
- **Adaptive Cards** -- Rich interactive cards with fact sets, images, buttons, and input fields.
- **JWT authentication** -- Inbound webhooks are verified using JWT tokens from the Microsoft Bot Framework.

### WhatsApp: Key Limitations

WhatsApp is widely used but has significant constraints:

- **No threading** -- All messages in a conversation are flat. There is no concept of threads or reply chains within the platform.
- **No streaming** -- Responses are delivered as complete messages. The user does not see the agent "typing" character by character.
- **4,096 character limit** -- Messages are capped at 4,096 characters. Long responses must be split.
- **Interactive messages only** -- Rich content is limited to WhatsApp's interactive message types: buttons (max 3) and list pickers.
- **Media support** -- Images, documents, audio, and video are supported through the Media API.

> **Key Concept**: When designing multi-channel agents, always consider WhatsApp's limitations. If your agent relies on threaded conversations or streaming for a good user experience, WhatsApp users will have a different (potentially degraded) experience. Design your agent's responses to be concise and self-contained.

### Slack Block Kit: Limits to Know

Slack's Block Kit is powerful but has strict limits:

- **Maximum 50 blocks** per message -- If your agent generates a response with more than 50 blocks, the Slack API will reject it.
- **Maximum 3,000 characters** per text element -- Individual text blocks cannot exceed this limit.
- **Validation required** -- Slack strictly validates block structure. Malformed blocks cause API errors.

These limits matter when your agent generates dynamic content. A carousel of 60 product cards will fail on Slack. Design your responses with these constraints in mind, and use Slack's Block Kit Builder to validate complex layouts.

```abl
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
```

## Rich Content Across Channels

Agent Platform uses the `RICH_CONTENT` block to provide channel-specific formatting alongside a plain text fallback. The runtime selects the format that matches the connected channel.

```abl
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
            {"title": "Total", "value": "${{total}}"}
          ]}
        ]
      }
    slack: |
      {
        "blocks": [
          {"type": "header", "text": {"type": "plain_text", "text": "Booking Confirmed"}},
          {"type": "section", "fields": [
            {"type": "mrkdwn", "text": "*Hotel:* {{hotel_name}}"},
            {"type": "mrkdwn", "text": "*Total:* ${{total}}"}
          ]}
        ]
      }
    whatsapp: |
      {
        "type": "interactive",
        "interactive": {
          "type": "button",
          "body": {"text": "Booking confirmed for {{hotel_name}}. Total: ${{total}}"},
          "action": {
            "buttons": [
              {"type": "reply", "reply": {"id": "details", "title": "View Details"}},
              {"type": "reply", "reply": {"id": "modify", "title": "Modify Booking"}}
            ]
          }
        }
      }
```

If a channel-specific format is not provided, the runtime falls back to the plain text `RESPOND` message. Always provide a meaningful plain text message as the universal fallback.

## Channel Identity Continuity

When users interact with your agent across channels -- starting on web chat, then calling in by phone -- the platform preserves their identity using a tiered verification model.

### Identity Tiers

| Tier   | Strength  | Description                                                               | Example                                                               |
| ------ | --------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **T0** | Anonymous | No identity signal. New unverified session.                               | First-time web visitor with no cookies                                |
| **T1** | Weak      | Identity recognized but not cryptographically verified. Could be spoofed. | Caller ID match from Twilio, browser cookie from web SDK              |
| **T2** | Strong    | Cryptographically verified. High confidence in identity.                  | OAuth token verification, OTP confirmation, HMAC-signed session token |

> **Key Concept**: T1 (weak identity) is what you get from caller ID. When a phone call comes in, the platform can match the caller's phone number to a known user -- but caller ID can be spoofed. This is sufficient for greeting them by name ("Welcome back, Jane!") but not for authorizing a bank transfer. Sensitive operations should require T2 verification.

### How identity flows across channels

```abl
FLOW:
  entry:
    REASONING: false
    # The platform resolves caller identity from the voice provider.
    # If the caller is recognized at T1 or T2, their context is available.
    - IF: caller.identityTier >= 1
      RESPOND: "Welcome back, {{caller.name}}! How can I help you today?"
      THEN: handle_request
    - ELSE:
      RESPOND: "Hello! I will need to verify your identity before we proceed."
      THEN: verify_identity
```

The platform's `CallerContext` structure is unified across Twilio, KoreVG, and LiveKit voice providers. A user who verified on web chat can be recognized when they call in, provided the caller ID or channel artifact matches and the channel connection's verification strength is configured.

## Email Channel

The email channel enables agents to handle inbound emails and send structured responses via email. Unlike real-time channels (Slack, web chat, voice), email is inherently asynchronous -- users do not expect immediate responses, and conversations can span hours or days.

### How the Email Adapter Works

The email adapter follows the same `ChannelAdapter` pattern as other channels:

1. **Inbound**: The platform monitors a configured mailbox (SMTP/IMAP or provider integration). New emails trigger the adapter.
2. **Normalization**: The adapter extracts the email body, subject, sender, attachments, and thread references into a `NormalizedIncomingMessage`.
3. **Session mapping**: Reply chains are mapped to existing sessions using email thread headers (`In-Reply-To`, `References`). New emails create new sessions.
4. **Processing**: The agent processes the message normally -- the agent does not know (or care) that the message came from email.
5. **Delivery**: The agent's response is formatted as an HTML email and sent back to the sender.

### Email-Specific Considerations

| Consideration           | Detail                                                          |
| ----------------------- | --------------------------------------------------------------- |
| **No streaming**        | Email responses are delivered as complete messages              |
| **No typing indicator** | The `sendTypingIndicator()` method is a no-op                   |
| **HTML formatting**     | Responses can include rich HTML via `RICH_CONTENT` email field  |
| **Attachments**         | Inbound attachments are processed through the document pipeline |
| **Thread tracking**     | Reply chains maintain session continuity across multiple emails |
| **Latency tolerance**   | Users expect minutes-to-hours response times, not seconds       |

### Rich Content in Email

```abl
RESPOND: "Your booking is confirmed"
  RICH_CONTENT:
    email: |
      <h2>Booking Confirmed</h2>
      <table>
        <tr><td><strong>Hotel:</strong></td><td>{{hotel_name}}</td></tr>
        <tr><td><strong>Dates:</strong></td><td>{{checkin}} - {{checkout}}</td></tr>
        <tr><td><strong>Total:</strong></td><td>${{total}}</td></tr>
      </table>
      <p>Reply to this email if you need to make changes.</p>
```

Email is particularly effective for B2B workflows, support ticket management, order confirmations, and any use case where asynchronous, documented communication is preferred over real-time chat.

## Voice Channel Specifics

Voice channels add unique considerations beyond text-based channels:

- **STT/TTS providers** -- Voice requires speech-to-text (Deepgram) and text-to-speech (ElevenLabs) providers configured alongside the voice gateway.
- **SSML support** -- Use SSML for fine-grained speech control (pauses, emphasis, pronunciation).
- **BYOC SIP** -- Bring your own SIP trunk for enterprise telephony integration.

```abl
RESPOND: "Your account balance is ${{balance}}."
  VOICE:
    SSML: |
      <speak>
        Your account balance is
        <say-as interpret-as="currency">USD{{balance}}</say-as>.
        <break time="500ms"/>
        Is there anything else I can help with?
      </speak>
```

## Key Takeaways

- Every channel adapter implements 5 methods: `verifyRequest()`, `parseIncoming()`, `sendResponse()`, `transformOutput()`, and `sendTypingIndicator()`
- Messages are normalized and enqueued to BullMQ after normalization, decoupling webhook acknowledgment from agent execution
- Teams supports streaming and threading; WhatsApp supports neither -- design agents with the lowest common denominator in mind
- Slack Block Kit has strict limits: 50 blocks max and 3,000 characters per text element
- Identity tier T1 (weak/caller ID) enables recognition but not authorization; T2 (strong/cryptographic) is required for sensitive operations

## What's Next

Explore the [SDK & Transport](../sdk-transport/content.md) module to learn how to embed agents in custom web applications, or the [Patterns & Deployment](../patterns-deployment/content.md) module for enterprise deployment considerations.
