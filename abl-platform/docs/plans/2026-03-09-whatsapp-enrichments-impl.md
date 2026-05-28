# WhatsApp Enrichments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add support for reaction, contact card, and location message types across WhatsApp providers (Meta Cloud, Infobip, Gupshup).

**Architecture:** Each WhatsApp provider implements `WhatsAppProvider` with `shouldProcess()` (type filtering) and `buildNormalizedMessage()` (payload → `NormalizedIncomingMessage`). We add new message types to each provider's processable types set and add handler branches in `buildNormalizedMessage()`. Tests use vitest with provider-specific test helpers.

**Tech Stack:** TypeScript, vitest, WhatsApp Business API webhooks

---

### Task 1: Meta Cloud — Reaction Messages

**Files:**

- Modify: `apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts`
- Test: `apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts`

**Step 1: Write failing tests**

Add to `apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts` inside the existing `WhatsAppAdapter.shouldProcess` describe block:

```typescript
it('returns true for reaction messages', () => {
  const body = makeWebhookPayload({
    type: 'reaction',
    reaction: { message_id: 'wamid.orig123', emoji: '👍' },
  });
  expect(adapter.shouldProcess(body)).toBe(true);
});
```

Add inside the existing `WhatsAppAdapter.buildNormalizedMessage` describe block:

```typescript
it('normalizes reaction message with emoji', () => {
  const body = makeWebhookPayload({
    type: 'reaction',
    reaction: { message_id: 'wamid.orig123', emoji: '👍' },
  });
  const msg = adapter.buildNormalizedMessage(body);
  expect(msg.text).toBe('👍');
  expect(msg.metadata?.isReaction).toBe(true);
  expect(msg.metadata?.reactionMessageId).toBe('wamid.orig123');
});

it('normalizes reaction removal (empty emoji)', () => {
  const body = makeWebhookPayload({
    type: 'reaction',
    reaction: { message_id: 'wamid.orig123', emoji: '' },
  });
  const msg = adapter.buildNormalizedMessage(body);
  expect(msg.text).toBe('');
  expect(msg.metadata?.isReaction).toBe(true);
  expect(msg.metadata?.reactionRemoved).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/whatsapp-adapter.test.ts`
Expected: FAIL — `shouldProcess` returns false for reaction type, `buildNormalizedMessage` doesn't handle reaction

**Step 3: Implement reaction support in Meta Cloud provider**

In `meta-cloud-provider.ts`:

1. Update the `WhatsAppMessage` interface — add `'reaction'` to the `type` union and add the `reaction` field:

```typescript
interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: 'text' | 'interactive' | 'button' | 'image' | 'audio' | 'video' | 'document' | 'reaction';
  // ... existing fields ...
  reaction?: { message_id: string; emoji: string };
}
```

2. Add `'reaction'` to the `processableTypes` array in `shouldProcess()`.

3. Add reaction handling in `buildNormalizedMessage()`, before the standard text fallback:

```typescript
// Handle reaction messages
if (msg.type === 'reaction' && msg.reaction) {
  const emoji = msg.reaction.emoji || '';
  return {
    externalMessageId: msg.id,
    externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
    text: emoji,
    metadata: {
      whatsappPhoneNumberId: phoneNumberId,
      whatsappFrom: msg.from,
      whatsappContactName: contact?.profile?.name,
      isReaction: true,
      reactionMessageId: msg.reaction.message_id,
      ...(emoji === '' && { reactionRemoved: true }),
    },
    timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/whatsapp-adapter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts
git add apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts
git commit -m "feat(runtime): add reaction message support to Meta Cloud WhatsApp provider"
```

---

### Task 2: Meta Cloud — Contact Card Messages

**Files:**

- Modify: `apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts`
- Test: `apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts`

**Step 1: Write failing tests**

Add to `WhatsAppAdapter.shouldProcess`:

```typescript
it('returns true for contacts messages', () => {
  const body = makeWebhookPayload({
    type: 'contacts',
    contacts: [{ name: { formatted_name: 'Alice' }, phones: [{ phone: '+1555' }] }],
  });
  expect(adapter.shouldProcess(body)).toBe(true);
});
```

Add to `WhatsAppAdapter.buildNormalizedMessage`:

```typescript
it('normalizes single contact card', () => {
  const body = makeWebhookPayload({
    type: 'contacts',
    contacts: [
      {
        name: { formatted_name: 'John Doe', first_name: 'John', last_name: 'Doe' },
        phones: [{ phone: '+1555987654', type: 'CELL' }],
        emails: [{ email: 'john@example.com', type: 'WORK' }],
      },
    ],
  });
  const msg = adapter.buildNormalizedMessage(body);
  expect(msg.text).toBe('Shared contact: John Doe (+1555987654, john@example.com)');
  expect(msg.metadata?.contacts).toHaveLength(1);
});

it('normalizes multiple contact cards', () => {
  const body = makeWebhookPayload({
    type: 'contacts',
    contacts: [
      { name: { formatted_name: 'Alice' }, phones: [{ phone: '+111' }] },
      { name: { formatted_name: 'Bob' }, phones: [{ phone: '+222' }] },
    ],
  });
  const msg = adapter.buildNormalizedMessage(body);
  expect(msg.text).toBe('Shared contact: Alice (+111)\nShared contact: Bob (+222)');
});

it('normalizes contact with name only (no phone, no email)', () => {
  const body = makeWebhookPayload({
    type: 'contacts',
    contacts: [{ name: { formatted_name: 'Jane' } }],
  });
  const msg = adapter.buildNormalizedMessage(body);
  expect(msg.text).toBe('Shared contact: Jane');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/whatsapp-adapter.test.ts`
Expected: FAIL

**Step 3: Implement contacts support in Meta Cloud provider**

In `meta-cloud-provider.ts`:

1. Add `'contacts'` to the `WhatsAppMessage.type` union.

2. Add contacts field to `WhatsAppMessage`:

```typescript
contacts?: Array<{
  name: { formatted_name?: string; first_name?: string; last_name?: string };
  phones?: Array<{ phone: string; type?: string }>;
  emails?: Array<{ email: string; type?: string }>;
}>;
```

3. Add `'contacts'` to `processableTypes` array.

4. Add contacts handling in `buildNormalizedMessage()`:

```typescript
// Handle contact card messages
if (msg.type === 'contacts' && msg.contacts) {
  const contactLines = msg.contacts.map((c) => {
    const name = c.name?.formatted_name || c.name?.first_name || 'Unknown';
    const details: string[] = [];
    if (c.phones?.[0]?.phone) details.push(c.phones[0].phone);
    if (c.emails?.[0]?.email) details.push(c.emails[0].email);
    return details.length > 0
      ? `Shared contact: ${name} (${details.join(', ')})`
      : `Shared contact: ${name}`;
  });

  return {
    externalMessageId: msg.id,
    externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
    text: contactLines.join('\n'),
    metadata: {
      whatsappPhoneNumberId: phoneNumberId,
      whatsappFrom: msg.from,
      whatsappContactName: contact?.profile?.name,
      contacts: msg.contacts,
    },
    timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/whatsapp-adapter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts
git add apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts
git commit -m "feat(runtime): add contact card message support to Meta Cloud WhatsApp provider"
```

---

### Task 3: Meta Cloud — Location Messages

**Files:**

- Modify: `apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts`
- Test: `apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts`

**Step 1: Write failing tests**

Add to `WhatsAppAdapter.shouldProcess`:

```typescript
it('returns true for location messages', () => {
  const body = makeWebhookPayload({
    type: 'location',
    location: { latitude: 37.7749, longitude: -122.4194 },
  });
  expect(adapter.shouldProcess(body)).toBe(true);
});
```

Add to `WhatsAppAdapter.buildNormalizedMessage`:

```typescript
it('normalizes location with name', () => {
  const body = makeWebhookPayload({
    type: 'location',
    location: {
      latitude: 37.7749,
      longitude: -122.4194,
      name: 'San Francisco',
      address: 'San Francisco, CA, USA',
    },
  });
  const msg = adapter.buildNormalizedMessage(body);
  expect(msg.text).toBe('Location: San Francisco (37.7749, -122.4194)');
  expect(msg.metadata?.location).toEqual({
    latitude: 37.7749,
    longitude: -122.4194,
    name: 'San Francisco',
    address: 'San Francisco, CA, USA',
  });
});

it('normalizes location without name', () => {
  const body = makeWebhookPayload({
    type: 'location',
    location: { latitude: 37.7749, longitude: -122.4194 },
  });
  const msg = adapter.buildNormalizedMessage(body);
  expect(msg.text).toBe('Location: 37.7749, -122.4194');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/whatsapp-adapter.test.ts`
Expected: FAIL

**Step 3: Implement location support in Meta Cloud provider**

In `meta-cloud-provider.ts`:

1. Add `'location'` to the `WhatsAppMessage.type` union.

2. Add location field to `WhatsAppMessage`:

```typescript
location?: { latitude: number; longitude: number; name?: string; address?: string };
```

3. Add `'location'` to `processableTypes` array.

4. Add location handling in `buildNormalizedMessage()`:

```typescript
// Handle location messages
if (msg.type === 'location' && msg.location) {
  const { latitude, longitude, name, address } = msg.location;
  const text = name
    ? `Location: ${name} (${latitude}, ${longitude})`
    : `Location: ${latitude}, ${longitude}`;

  return {
    externalMessageId: msg.id,
    externalSessionKey: `whatsapp:${phoneNumberId}:${msg.from}`,
    text,
    metadata: {
      whatsappPhoneNumberId: phoneNumberId,
      whatsappFrom: msg.from,
      whatsappContactName: contact?.profile?.name,
      location: msg.location,
    },
    timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/whatsapp-adapter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts
git add apps/runtime/src/channels/adapters/whatsapp-providers/meta-cloud-provider.ts apps/runtime/src/__tests__/adapters/whatsapp-adapter.test.ts
git commit -m "feat(runtime): add location message support to Meta Cloud WhatsApp provider"
```

---

### Task 4: Infobip — Contact Card Messages

**Files:**

- Modify: `apps/runtime/src/channels/adapters/whatsapp-providers/infobip-provider.ts`
- Test: `apps/runtime/src/__tests__/adapters/infobip-provider.test.ts`

**Step 1: Write failing tests**

Add to the `shouldProcess` describe block in `infobip-provider.test.ts`:

```typescript
it('returns true for CONTACT message', () => {
  const payload = makeInfobipPayload({ type: 'CONTACT' });
  expect(provider.shouldProcess(payload)).toBe(true);
});
```

Add to the `buildNormalizedMessage` describe block:

```typescript
it('maps CONTACT message to formatted text', () => {
  const payload = {
    results: [
      {
        from: '447415774332',
        to: '447860099299',
        integrationType: 'WHATSAPP',
        receivedAt: '2024-08-18T09:30:52.516+0000',
        messageId: 'ABEGRHQVd0QyAhCEOHQDx2_nQGlWh5eTJdht',
        message: {
          type: 'CONTACT',
          contacts: [
            {
              name: { formatted_name: 'John Doe', first_name: 'John', last_name: 'Doe' },
              phones: [{ phone: '+1555987654', type: 'CELL' }],
              emails: [{ email: 'john@example.com', type: 'WORK' }],
            },
          ],
        },
        contact: { name: 'Sender Name' },
      },
    ],
    messageCount: 1,
    pendingMessageCount: 0,
  };
  const result = provider.buildNormalizedMessage(payload);
  expect(result.text).toBe('Shared contact: John Doe (+1555987654, john@example.com)');
  expect(result.metadata?.contacts).toHaveLength(1);
});

it('maps CONTACT with name only', () => {
  const payload = {
    results: [
      {
        from: '447415774332',
        to: '447860099299',
        integrationType: 'WHATSAPP',
        receivedAt: '2024-08-18T09:30:52.516+0000',
        messageId: 'ABEGRHQVd0QyAhCEOHQDx2_test',
        message: {
          type: 'CONTACT',
          contacts: [{ name: { formatted_name: 'Jane' } }],
        },
        contact: { name: 'Sender' },
      },
    ],
    messageCount: 1,
    pendingMessageCount: 0,
  };
  const result = provider.buildNormalizedMessage(payload);
  expect(result.text).toBe('Shared contact: Jane');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/infobip-provider.test.ts`
Expected: FAIL

**Step 3: Implement contact support in Infobip provider**

In `infobip-provider.ts`:

1. Add `'CONTACT'` to `PROCESSABLE_MESSAGE_TYPES`.

2. Extend `InfobipMessage` interface:

```typescript
interface InfobipMessage {
  type: string;
  text?: string;
  caption?: string;
  url?: string;
  id?: string;
  latitude?: number;
  longitude?: number;
  contacts?: Array<{
    name: { formatted_name?: string; first_name?: string; last_name?: string };
    phones?: Array<{ phone: string; type?: string }>;
    emails?: Array<{ email: string; type?: string }>;
  }>;
}
```

3. Add contact handling in `buildNormalizedMessage()`, after the LOCATION handler:

```typescript
// Handle contact card messages
if (message.type === 'CONTACT' && message.contacts) {
  const contactLines = message.contacts.map((c) => {
    const name = c.name?.formatted_name || c.name?.first_name || 'Unknown';
    const details: string[] = [];
    if (c.phones?.[0]?.phone) details.push(c.phones[0].phone);
    if (c.emails?.[0]?.email) details.push(c.emails[0].email);
    return details.length > 0
      ? `Shared contact: ${name} (${details.join(', ')})`
      : `Shared contact: ${name}`;
  });

  return {
    externalMessageId,
    externalSessionKey,
    text: contactLines.join('\n'),
    metadata: {
      ...baseMetadata,
      contacts: message.contacts,
    },
    timestamp,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/infobip-provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/channels/adapters/whatsapp-providers/infobip-provider.ts apps/runtime/src/__tests__/adapters/infobip-provider.test.ts
git add apps/runtime/src/channels/adapters/whatsapp-providers/infobip-provider.ts apps/runtime/src/__tests__/adapters/infobip-provider.test.ts
git commit -m "feat(runtime): add contact card message support to Infobip WhatsApp provider"
```

---

### Task 5: Gupshup — Improve Contacts Handler

**Files:**

- Modify: `apps/runtime/src/channels/adapters/whatsapp-providers/gupshup-provider.ts`
- Test: `apps/runtime/src/__tests__/adapters/gupshup-provider.test.ts`

**Step 1: Update existing test and add new tests**

The existing test at line 320 (`maps contacts: text = raw JSON string`) needs to be updated. Replace it and add edge cases:

```typescript
it('maps contacts: formats contact as readable text', () => {
  const body = makeGupshupBody({
    type: 'contacts',
    text: undefined,
    contacts: JSON.stringify([
      {
        name: { formatted_name: 'Alice Smith' },
        phones: [{ phone: '+1234567890' }],
        emails: [{ email: 'alice@example.com' }],
      },
    ]),
  });
  const result = provider.buildNormalizedMessage(body);
  expect(result.text).toBe('Shared contact: Alice Smith (+1234567890, alice@example.com)');
  expect(result.metadata?.contacts).toHaveLength(1);
});

it('maps contacts with invalid JSON: falls back to raw string', () => {
  const body = makeGupshupBody({
    type: 'contacts',
    text: undefined,
    contacts: 'not-valid-json',
  });
  const result = provider.buildNormalizedMessage(body);
  expect(result.text).toBe('not-valid-json');
});

it('maps contacts with name only', () => {
  const body = makeGupshupBody({
    type: 'contacts',
    text: undefined,
    contacts: JSON.stringify([{ name: { formatted_name: 'Bob' } }]),
  });
  const result = provider.buildNormalizedMessage(body);
  expect(result.text).toBe('Shared contact: Bob');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/gupshup-provider.test.ts`
Expected: FAIL — the first test expects formatted text but gets raw JSON

**Step 3: Update Gupshup contacts handler**

In `gupshup-provider.ts`, replace the contacts handler (around line 347):

```typescript
// Handle contacts messages
if (messageType === 'contacts') {
  const parsed = safeJsonParse(b.contacts);
  if (parsed === null) {
    // Invalid JSON — fall back to raw string
    return {
      externalMessageId,
      externalSessionKey,
      text: b.contacts || '',
      metadata: baseMetadata,
      timestamp,
    };
  }

  const contactsArray = Array.isArray(parsed) ? parsed : [parsed];
  const contactLines = contactsArray.map((c: Record<string, unknown>) => {
    const nameObj = c.name as Record<string, string> | undefined;
    const name = nameObj?.formatted_name || nameObj?.first_name || 'Unknown';
    const phones = c.phones as Array<{ phone: string }> | undefined;
    const emails = c.emails as Array<{ email: string }> | undefined;
    const details: string[] = [];
    if (phones?.[0]?.phone) details.push(phones[0].phone);
    if (emails?.[0]?.email) details.push(emails[0].email);
    return details.length > 0
      ? `Shared contact: ${name} (${details.join(', ')})`
      : `Shared contact: ${name}`;
  });

  return {
    externalMessageId,
    externalSessionKey,
    text: contactLines.join('\n'),
    metadata: {
      ...baseMetadata,
      contacts: contactsArray,
    },
    timestamp,
  };
}
```

Note: `safeJsonParse` currently returns `Record<string, unknown> | null`. Since Gupshup sends contacts as a JSON array string, the parsed result will be an array. We check `Array.isArray` to handle both.

**Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && pnpm exec vitest run src/__tests__/adapters/gupshup-provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/channels/adapters/whatsapp-providers/gupshup-provider.ts apps/runtime/src/__tests__/adapters/gupshup-provider.test.ts
git add apps/runtime/src/channels/adapters/whatsapp-providers/gupshup-provider.ts apps/runtime/src/__tests__/adapters/gupshup-provider.test.ts
git commit -m "feat(runtime): improve Gupshup contacts handler to format readable text"
```

---

### Task 6: Full Regression Test

**Step 1: Build runtime**

Run: `pnpm turbo build --filter=@agent-platform/runtime`
Expected: Clean build with no errors

**Step 2: Run all WhatsApp-related tests**

Run: `cd apps/runtime && pnpm exec vitest run --reporter=verbose src/__tests__/adapters/whatsapp-adapter.test.ts src/__tests__/adapters/whatsapp-file-attachments.test.ts src/__tests__/adapters/infobip-provider.test.ts src/__tests__/adapters/gupshup-provider.test.ts src/__tests__/adapters/netcore-provider.test.ts`
Expected: ALL PASS — no regressions in existing tests, all new tests pass

**Step 3: Final commit if any formatting adjustments needed**

```bash
npx prettier --write apps/runtime/src/channels/adapters/whatsapp-providers/*.ts apps/runtime/src/__tests__/adapters/*.test.ts
git diff --quiet || (git add -A && git commit -m "style(runtime): format whatsapp provider files")
```
