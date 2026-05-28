// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: guides/channels.mdx
// Regenerate: pnpm abl:docs:generate

export const CHANNELS_VOICE_CARD = `## Voice Channels — S2S, Pipeline, VXML, AudioCodes

## Set Up Voice
- Set up a voice channel so users can interact with your agent through phone calls, using speech-to-text and text-to-speech for natural voice conversations.
### Jambonz Voice Setup
- The platform supports voice through Jambonz (SIP gateway) and Twilio.
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/channel-connections \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "channelType": "jambonz",
    "name": "Voice Support Line",
    "config": {
      "provider": "jambonz",
      "welcomeMessage": "Hello! How can I help you today?",
      "voiceConfig": {
        "sttProvider": "deepgram",
        "sttLanguage": "en-US",
        "ttsProvider": "elevenlabs",
        "ttsVoice": "rachel"
      }
    },
    "environment": "production"
  }'
\`\`\`
The response includes a SIP endpoint to point your phone number at.
### Twilio Voice Setup
For Twilio-based voice, create a channel connection with Twilio credentials.
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/channel-connections \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "channelType": "twilio_voice",
    "name": "Twilio Voice",
    "credentials": {
      "account_sid": "your-twilio-account-sid",
      "auth_token": "your-twilio-auth-token"
    },
    "config": {
      "phoneNumber": "+15551234567"
    },
    "environment": "production"
  }'
\`\`\`
Configure the Twilio phone number's webhook to point to the platform's voice endpoint.
### Use Caller Identity in Voice Agents
- For voice sessions, the runtime makes caller identity available through the \`session\` namespace.
| Field                        | Description                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| \`session.anonymousId\`        | Normalized caller identity. For phone calls, this is the caller ANI when the gateway provides a valid phone number. |
| \`session.sessionPrincipalId\` | Same recognized session principal used for contact resolution and session ownership checks.                         |
| \`session.calledNumber\`       | Normalized number the caller dialed, when available.                                                                |
| \`session.rawCallerId\`        | Raw caller value before phone normalization.                                                                        |
| \`session.rawFrom\`            | Raw upstream \`From\` value before phone normalization.                                                               |
| \`session.rawCalledNumber\`    | Raw called value before phone normalization.                                                                        |
| \`session.rawTo\`              | Raw upstream \`To\` value before phone normalization.                                                                 |
- The runtime normalizes phone-like values from the voice gateway.
Use the normalized fields for most tools:
\`\`\`abl
TOOLS:
  lookup_customer(phone: string, called_number?: string) -> object
    description: "Find the customer record for a voice caller."

FLOW:
  identify_caller

  identify_caller:
    REASONING: false
    CALL: lookup_customer
      WITH:
        phone: session.anonymousId
        called_number: session.calledNumber
      AS: customer
    RESPOND: "Thanks. I found your account."
\`\`\`
- Use raw fields only when your integration needs the original gateway value for audit or carrier-spec
\`\`\`abl
CALL: record_voice_context
  WITH:
    caller_id: session.anonymousId
    raw_from: session.rawFrom
    called_number: session.calledNumber
    raw_to: session.rawTo
  AS: voiceContext
\`\`\`
- Caller identity fields can contain phone numbers or carrier-provided identifiers, so treat them as end-user identity data.
### Add Voice-Specific Responses to Your Agent
Use \`VOICE\` blocks in your agent to provide voice-optimized output alongside text.
\`\`\`abl
FLOW:
  welcome:
    REASONING: false
    RESPOND: "Welcome to Acme Support. How can I help?"
      VOICE:
        INSTRUCTIONS: "Use a warm, professional tone. Speak at a moderate pace."

  confirm_booking:
    REASONING: false
    RESPOND: "Your booking is confirmed. Confirmation number: {{confirmation_id}}."
      VOICE:
        INSTRUCTIONS: "Read the confirmation number slowly and clearly, one character at a time."
        SSML: |
          <speak>
            Your booking is confirmed.
            Confirmation number: <say-as interpret-as="characters">{{confirmation_id}}</say-as>.
          </speak>
\`\`\`
### BYOC SIP (Bring Your Own Carrier)
Connect your existing SIP trunk to the platform.
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/channel-connections \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "channelType": "jambonz",
    "name": "Enterprise SIP",
    "config": {
      "provider": "byoc_sip",
      "sipGateway": "192.168.1.100:5060",
      "voiceConfig": {
        "sttProvider": "deepgram",
        "ttsProvider": "elevenlabs",
        "ttsVoice": "rachel"
      }
    }
  }'
\`\`\`
### AudioCodes Voice Gateway
For AudioCodes VoiceAI Connect integration:
\`\`\`bash
curl -X POST https://your-platform/api/projects/\$PROJECT_ID/channel-connections \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "channelType": "audiocodes",
    "name": "AudioCodes Voice",
    "config": {
      "botUrl": "https://your-platform/api/v1/channels/audiocodes/webhook"
    }
  }'
\`\`\`
### Browser-Based Voice (Twilio Client)
Generate a Twilio token for browser-based voice calls from your web application.
\`\`\`bash
curl -X POST https://your-platform/api/v1/voice/token \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "your-project-id",
    "identity": "user-123"
  }'
\`\`\`
Use the returned token with the Twilio Client SDK in your frontend:
\`\`\`typescript
import { Device } from '@twilio/voice-sdk';

const device = new Device(token);
await device.register();

// Make a call
const call = await device.connect({
  params: { projectId: 'your-project-id' },
});
\`\`\`
### Voice with SSML
Use SSML for fine-grained control over speech output (pauses, emphasis, pronunciation).
\`\`\`abl
RESPOND: "Your account balance is \${{balance}}."
  VOICE:
    SSML: |
      <speak>
        Your account balance is
        <say-as interpret-as="currency">USD{{balance}}</say-as>.
        <break time="500ms"/>
        Is there anything else I can help with?
      </speak>
\`\`\`
### Troubleshooting
- **No audio in voice calls:** Verify the STT and TTS providers are configured and their API keys are valid. Check the voice service health endpoint.
- **Webhook signature validation fails (Twilio):** The \`auth_token\` must match the Twilio account's Auth Token. The platform uses it to validate \`X-Twilio-Signature\` on incoming webhooks.
- **Voice responses cut off:** Long text responses may exceed TTS limits. Keep voice responses concise or use SSML with \`<break>\` tags to create natural pauses.
- **SIP registration fails:** For BYOC SIP, verify the SIP gateway IP and port are correct and that the gateway allows connections from the platform's IP range.`;
