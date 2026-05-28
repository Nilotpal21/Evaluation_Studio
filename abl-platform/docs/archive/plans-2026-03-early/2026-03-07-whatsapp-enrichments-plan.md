# WhatsApp Enrichments — Reactions, Contact Cards, Location

**Date:** 2026-03-07 (updated 2026-03-09)
**Branch:** `feat/whatsapp-enrichments`
**Effort:** ~3 days estimated
**Source:** Channel Gap Analysis (Section 4.2 — Feature Gaps Within Existing Channels)

---

## Scope

Three message types that WhatsApp providers don't fully process yet: reactions, contact cards, and location sharing. Changes span Meta Cloud, Infobip, and Gupshup providers. Netcore is unaffected.

---

## Cross-Provider Support Matrix

Research into each BSP's API documentation (2026-03-09) confirms that not all providers forward all three message types in their webhook payloads:

| Feature       | Meta Cloud   | Infobip                                   | Gupshup                              | Netcore                                                                         |
| ------------- | ------------ | ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| **Reactions** | ✅ Supported | ❌ Not in inbound types                   | ❌ Not listed as message type        | ❌ Not listed                                                                   |
| **Contacts**  | ✅ Supported | ✅ "Contact — vCard-format contact cards" | ✅ Already handled (type: `contact`) | ⚠️ Arrives as `message_type: "text"` with `.vcf` attachment — no dedicated type |
| **Location**  | ✅ To add    | ✅ Already handled                        | ✅ Already handled                   | ✅ Already handled                                                              |

### Adjusted Scope Per Provider

- **Meta Cloud**: Add all 3 (reactions, contacts, location)
- **Infobip**: Add contacts (only missing supported type; reactions not available)
- **Gupshup**: Improve existing contacts handler (currently dumps raw JSON as text)
- **Netcore**: No new types to add (contacts arrive as text/file, reactions unavailable)

### Sources

- Infobip: https://www.infobip.com/docs/whatsapp/message-types-and-templates/inbound-messages
- Gupshup: https://docs.gupshup.io/docs/what-is-an-inbound-message (type must be one of: `text`, `image`, `file`, `audio`, `video`, `contact`, `location`)
- Netcore: https://emaildocs.netcorecloud.com/docs/incoming-message-webhooks (WhatsApp types: TEXT, IMAGE, VIDEO, DOCUMENT, AUDIO, LOCATION, INTERACTIVE)

---

## Task 1: Meta Cloud — Reaction Messages

### What

WhatsApp users can react to messages with emojis. Currently ignored because `reaction` is not in the `processableTypes` list.

### Webhook Payload

```json
{
  "messages": [
    {
      "from": "15551234567",
      "id": "wamid.xxx",
      "timestamp": "1234567890",
      "type": "reaction",
      "reaction": {
        "message_id": "wamid.original_message_id",
        "emoji": "👍"
      }
    }
  ]
}
```

### Implementation

1. Add `'reaction'` to `WhatsAppMessage.type` union and `processableTypes` array
2. Add `reaction` field to `WhatsAppMessage` interface: `{ message_id: string; emoji: string }`
3. In `buildNormalizedMessage()`, handle `type === 'reaction'`:
   - Set `text` to the emoji string (empty string if reaction removal)
   - Set `metadata.reactionMessageId` to the original message ID
   - Set `metadata.isReaction = true`
   - If emoji is empty, set `metadata.reactionRemoved = true`

### Files

- `apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts`

### Tests

- Reaction webhook → normalized message with emoji as text + metadata
- Reaction removal (empty emoji) → `reactionRemoved: true`, empty text
- Non-processable type still filtered correctly

---

## Task 2: Meta Cloud — Contact Card Messages

### What

WhatsApp users can share contact cards (vCards). Currently ignored because `contacts` is not in processable types.

### Webhook Payload

```json
{
  "messages": [
    {
      "from": "15551234567",
      "id": "wamid.xxx",
      "timestamp": "1234567890",
      "type": "contacts",
      "contacts": [
        {
          "name": {
            "formatted_name": "John Doe",
            "first_name": "John",
            "last_name": "Doe"
          },
          "phones": [{ "phone": "+1555987654", "type": "CELL" }],
          "emails": [{ "email": "john@example.com", "type": "WORK" }]
        }
      ]
    }
  ]
}
```

### Implementation

1. Add `'contacts'` to `WhatsAppMessage.type` union and `processableTypes`
2. Add `contacts` field to `WhatsAppMessage` interface
3. In `buildNormalizedMessage()`, handle `type === 'contacts'`:
   - Format each contact as: `"Shared contact: John Doe (+1555987654, john@example.com)"`
   - Multiple contacts joined with newlines
   - Gracefully handle partial fields (no email, no phone, name only)
   - Store full contacts array in `metadata.contacts`

### Files

- `apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts`

### Tests

- Single contact → formatted text + metadata
- Multiple contacts → all included, newline-separated
- Contact with partial fields (no email, no phone) → handles gracefully
- Contact with only name → still processes

---

## Task 3: Meta Cloud — Location Messages

### What

WhatsApp users can share their location or a pin. Currently ignored because `location` is not in processable types for Meta Cloud (Infobip/Gupshup/Netcore already handle this).

### Webhook Payload

```json
{
  "messages": [
    {
      "from": "15551234567",
      "id": "wamid.xxx",
      "timestamp": "1234567890",
      "type": "location",
      "location": {
        "latitude": 37.7749,
        "longitude": -122.4194,
        "name": "San Francisco",
        "address": "San Francisco, CA, USA"
      }
    }
  ]
}
```

### Implementation

1. Add `'location'` to `WhatsAppMessage.type` union and `processableTypes`
2. Add `location` field to `WhatsAppMessage` interface: `{ latitude: number; longitude: number; name?: string; address?: string }`
3. In `buildNormalizedMessage()`, handle `type === 'location'`:
   - With name: `"Location: San Francisco (37.7749, -122.4194)"`
   - Without name: `"Location: 37.7749, -122.4194"`
   - Include address in metadata if provided
   - Store full location object in `metadata.location`

### Files

- `apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts`

### Tests

- Location with name + address → formatted text + metadata
- Location with only lat/lng → still processes
- Live location (if different from static) → handle or skip gracefully

---

## Task 4: Infobip — Contact Card Messages

### What

Infobip's WhatsApp API supports inbound contact cards (`CONTACT` type) but our provider doesn't handle them yet.

### Implementation

1. Add `'CONTACT'` to `PROCESSABLE_MESSAGE_TYPES`
2. Extend `InfobipMessage` interface with contact fields (need to verify exact Infobip payload shape)
3. In `buildNormalizedMessage()`, handle `message.type === 'CONTACT'`:
   - Format contact text matching Meta Cloud pattern
   - Store structured data in `metadata.contacts`

### Files

- `apps/runtime/src/channels/adapters/whatsapp-providers/infobip-provider.ts`

### Tests

- Contact webhook → formatted text + metadata
- Contact with partial fields → handles gracefully

---

## Task 5: Gupshup — Improve Contacts Handler

### What

Gupshup already handles `contacts` type but dumps the raw JSON string as text (line 351: `text: b.contacts || ''`). Should parse and format like other providers.

### Implementation

1. Parse `b.contacts` JSON string using existing `safeJsonParse()`
2. Format as readable text matching Meta Cloud pattern
3. Store parsed contacts in `metadata.contacts`

### Files

- `apps/runtime/src/channels/adapters/whatsapp-providers/gupshup-provider.ts`

### Tests

- Contact webhook → formatted text (not raw JSON) + metadata
- Invalid JSON → graceful fallback

---

## General Notes

- Primary changes are in `meta-cloud-provider.ts`; secondary changes in `infobip-provider.ts` and `gupshup-provider.ts`
- Netcore is unaffected (no new types to add)
- Run existing WhatsApp adapter tests after changes to ensure no regressions
- Add new test cases to the existing test file or create `whatsapp-enrichments.test.ts`
- Follow the existing `buildNormalizedMessage()` pattern for new message types
- All new message types must be filterable via `shouldProcess()` — don't break echo/stale filtering

## Test Commands

```bash
# Build
pnpm turbo build --filter=@agent-platform/runtime

# Run WhatsApp tests
pnpm --filter @agent-platform/runtime test -- --grep "whatsapp"
```

---

_End of Plan_
