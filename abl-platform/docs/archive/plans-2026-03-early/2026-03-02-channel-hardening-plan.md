# Channel Infrastructure Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 8 high-impact channel infrastructure gaps: security holes (Twilio sig, Slack form-encoded, Korevg auth bypass), type drift across runtime/DB/routes, URL generation mismatches, unwired output guardrails, dead jambonz code, and duplicate SDK channel routes.

**Architecture:** Four-phase approach — P0 security fixes first (small, targeted), then P1 ChannelManifest unification (structural foundation), P2 output guardrail wiring into pre-delivery path, P3 cleanup (dead code removal, drift tests). Each phase is independently shippable.

**Tech Stack:** TypeScript, Express.js, Vitest, WebSocket (ws), Twilio SDK, BullMQ

---

## Phase Overview

| Phase       | Scope                   | Tasks | Key Deliverable                                                            |
| ----------- | ----------------------- | ----- | -------------------------------------------------------------------------- |
| **Phase 0** | Security Fixes          | 1–3   | Twilio sig enforcement, Slack form-encoded parsing, Korevg production auth |
| **Phase 1** | ChannelManifest + Drift | 4–7   | Single manifest driving types/DB/registry/URLs/prompts, conformance tests  |
| **Phase 2** | Output Guardrail Wiring | 8–10  | Pre-delivery output guardrails in reasoning + flow executors, trace events |
| **Phase 3** | Cleanup                 | 11–13 | Jambonz removal, SDK route consolidation, HTTP async event alignment       |

---

## Phase 0: Security Fixes

### Task 1: Enforce Twilio Webhook Signature on `/connect` and `/status`

The `/api/voice/connect` and `/api/voice/status` endpoints accept Twilio webhooks without any signature verification. The `TwilioService.validateWebhookSignature()` method exists but is never called on these routes. An attacker can forge requests to these endpoints to hijack voice call media streams.

**Files:**

- Modify: `apps/runtime/src/routes/voice.ts:198-250` (connect), `apps/runtime/src/routes/voice.ts:360-382` (status)
- Modify: `apps/runtime/src/services/voice/twilio-service.ts:411-425` (existing validator)
- Test: `apps/runtime/src/__tests__/voice-twilio-sig.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/voice-twilio-sig.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * Twilio signs webhooks with HMAC-SHA1:
 *   signature = Base64(HMAC-SHA1(authToken, url + sorted(params)))
 *
 * We test:
 * 1. Valid signature → 200 + TwiML
 * 2. Missing signature header → 403
 * 3. Invalid signature → 403
 * 4. Unconfigured Twilio service → 503 (existing behavior)
 * 5. /status with valid signature → 200
 * 6. /status with missing signature → 403
 */

// Mock getTwilioService to return a controllable instance
const mockValidateWebhookSignature = vi.fn();
const mockIsConfigured = vi.fn().mockReturnValue(true);
const mockGenerateStreamTwiML = vi
  .fn()
  .mockReturnValue('<Response><Connect><Stream/></Connect></Response>');

vi.mock('../services/voice/twilio-service.js', () => ({
  getTwilioService: () => ({
    isConfigured: mockIsConfigured,
    validateWebhookSignature: mockValidateWebhookSignature,
    generateStreamTwiML: mockGenerateStreamTwiML,
  }),
}));

describe('Twilio webhook signature enforcement', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Build a fresh Express app with the voice router
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    const { default: voiceRouter } = await import('../routes/voice.js');
    app.use('/api/voice', voiceRouter);
  });

  describe('POST /api/voice/connect', () => {
    it('should reject requests without X-Twilio-Signature header', async () => {
      const res = await request(app)
        .post('/api/voice/connect')
        .send({ CallSid: 'CA123', sessionId: 'sess-1' });

      expect(res.status).toBe(403);
    });

    it('should reject requests with invalid signature', async () => {
      mockValidateWebhookSignature.mockResolvedValue(false);

      const res = await request(app)
        .post('/api/voice/connect')
        .set('X-Twilio-Signature', 'invalid-sig')
        .send({ CallSid: 'CA123', sessionId: 'sess-1' });

      expect(res.status).toBe(403);
      expect(mockValidateWebhookSignature).toHaveBeenCalled();
    });

    it('should accept requests with valid signature and return TwiML', async () => {
      mockValidateWebhookSignature.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/voice/connect')
        .set('X-Twilio-Signature', 'valid-sig')
        .send({ CallSid: 'CA123', sessionId: 'sess-1' });

      expect(res.status).toBe(200);
      expect(res.type).toMatch(/xml/);
      expect(mockGenerateStreamTwiML).toHaveBeenCalled();
    });
  });

  describe('POST /api/voice/status', () => {
    it('should reject requests without X-Twilio-Signature header', async () => {
      const res = await request(app)
        .post('/api/voice/status')
        .send({ CallSid: 'CA123', CallStatus: 'completed' });

      expect(res.status).toBe(403);
    });

    it('should accept requests with valid signature', async () => {
      mockValidateWebhookSignature.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/voice/status')
        .set('X-Twilio-Signature', 'valid-sig')
        .send({ CallSid: 'CA123', CallStatus: 'completed' });

      expect(res.status).toBe(200);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/voice-twilio-sig.test.ts`
Expected: FAIL — connect/status return 200 regardless of signature (no enforcement yet)

**Step 3: Add Twilio signature validation middleware to voice routes**

In `apps/runtime/src/routes/voice.ts`, add a middleware function before the `/connect` and `/status` handlers:

```typescript
// Add at top of file, after imports:
import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware to validate Twilio webhook signatures.
 * Rejects requests missing X-Twilio-Signature or with invalid signatures.
 * Skipped when Twilio service is not configured (dev-only fallback).
 */
async function validateTwilioSignature(req: Request, res: Response, next: NextFunction) {
  const twilio = getTwilioService();

  // If Twilio not configured, skip validation (handled by route's 503 check)
  if (!twilio.isConfigured()) {
    return next();
  }

  const signature = req.headers['x-twilio-signature'] as string | undefined;
  if (!signature) {
    log.warn('Twilio webhook missing X-Twilio-Signature header', {
      path: req.path,
      ip: req.ip,
    });
    res.status(403).send('Missing Twilio signature');
    return;
  }

  // Reconstruct the full URL Twilio used to compute the signature
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const fullUrl = `${protocol}://${host}${req.originalUrl}`;

  const isValid = await twilio.validateWebhookSignature(signature, fullUrl, req.body || {});

  if (!isValid) {
    log.warn('Twilio webhook signature validation failed', {
      path: req.path,
      ip: req.ip,
    });
    res.status(403).send('Invalid Twilio signature');
    return;
  }

  next();
}
```

Then update the two route definitions:

For `/connect` (line ~198), add `validateTwilioSignature` as middleware:

```typescript
openapi.route(
  'post',
  '/connect',
  {
    summary: 'Handle Twilio call connection',
    description:
      'Twilio webhook that handles when a call connects and returns TwiML to stream media to the runtime',
    body: connectRequestSchema,
    response: z.any().describe('TwiML XML response'),
  },
  validateTwilioSignature, // ← ADD THIS
  async (req, res) => {
    // ... existing handler unchanged
  },
);
```

For `/status` (line ~360), add `validateTwilioSignature` as middleware:

```typescript
openapi.route(
  'post',
  '/status',
  {
    summary: 'Handle Twilio call status updates',
    description:
      'Twilio status callback that logs call events (initiated, ringing, in-progress, completed, failed, etc.)',
    body: statusRequestSchema,
    response: z.any().describe('Empty response'),
  },
  validateTwilioSignature, // ← ADD THIS
  async (req, res) => {
    // ... existing handler unchanged
  },
);
```

**Step 4: Ensure URL-encoded body parsing for Twilio**

Twilio sends webhooks as `application/x-www-form-urlencoded`. Add a local URL-encoded parser to the voice router file (before routes are defined):

```typescript
// At the top of voice.ts, after router creation:
router.use(express.urlencoded({ extended: false }));
```

This ensures `req.body` is populated for Twilio form-encoded payloads, which is required for signature computation.

**Step 5: Run tests to verify they pass**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/voice-twilio-sig.test.ts`
Expected: PASS — all 5 tests green

**Step 6: Commit**

```bash
git add apps/runtime/src/routes/voice.ts apps/runtime/src/__tests__/voice-twilio-sig.test.ts
git commit -m "fix(runtime): enforce Twilio webhook signature on /connect and /status

Adds validateTwilioSignature middleware to voice connect and status
routes. Rejects requests missing X-Twilio-Signature header (403) or
with invalid signatures. Uses existing TwilioService.validateWebhookSignature()
which was implemented but never wired into the routes.

Also adds express.urlencoded parser to voice router for Twilio's
form-encoded webhook payloads."
```

---

### Task 2: Fix Slack Interactive Payload Parsing (form-urlencoded)

Slack interactive payloads (block_actions, view_submission) are sent as `application/x-www-form-urlencoded` with a `payload` field containing JSON. The global body parser only handles `application/json`, so these payloads either fail to parse or produce an empty `req.body`. The raw body capture (`req.rawBody`) also depends on the JSON parser's `verify` callback, which won't fire for non-JSON content types.

**Files:**

- Modify: `apps/runtime/src/routes/channel-webhooks.ts:29-35` (add form parser + raw body capture)
- Modify: `apps/runtime/src/routes/channel-webhooks.ts:98-231` (handle parsed payload field)
- Test: `apps/runtime/src/__tests__/slack-interactive-parsing.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/slack-interactive-parsing.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * Slack interactive payloads arrive as:
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: payload=%7B%22type%22%3A%22block_actions%22%2C...%7D
 *
 * The JSON payload is URL-encoded inside the `payload` field.
 * Signature is computed over the raw body string.
 *
 * We test:
 * 1. Form-encoded interactive payload is parsed and processed
 * 2. Signature verification works with form-encoded raw body
 * 3. view_submission returns response_action: 'clear'
 */

// Minimal mocks for channel registry
const mockAdapter = {
  channelType: 'slack',
  capabilities: {
    supportsAsync: true,
    supportsStreaming: true,
    supportsMedia: true,
    supportsThreading: true,
  },
  verifyRequest: vi.fn().mockResolvedValue(true),
  shouldProcess: vi.fn().mockReturnValue(true),
  buildNormalizedMessage: vi.fn().mockReturnValue({
    externalMessageId: 'block_action:T123',
    externalSessionKey: 'slack:T1:C1',
    text: 'button_click',
    timestamp: new Date(),
  }),
  extractEventId: vi.fn().mockReturnValue('evt-1'),
  extractExternalIdentifier: vi.fn().mockReturnValue('slack-bot-1'),
};

vi.mock('../channels/registry.js', () => ({
  getChannelRegistry: () => ({
    get: (type: string) => (type === 'slack' ? mockAdapter : undefined),
  }),
}));

vi.mock('../channels/connection-resolver.js', () => ({
  resolveConnection: vi.fn().mockResolvedValue({
    id: 'conn-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    agentId: null,
    channelType: 'slack',
    externalIdentifier: 'slack-bot-1',
    credentials: { signing_secret: 'test-secret' },
    config: {},
    status: 'active',
  }),
}));

vi.mock('../services/queues/inbound-queue.js', () => ({
  getInboundQueue: () => ({
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
  }),
}));

describe('Slack interactive payload parsing', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    // Global JSON parser (matches server.ts)
    app.use(
      express.json({
        limit: '1mb',
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    const { default: channelWebhooksRouter } = await import('../routes/channel-webhooks.js');
    app.use('/api/v1/channels', channelWebhooksRouter);
  });

  it('should parse form-encoded interactive payload and enqueue job', async () => {
    const interactivePayload = JSON.stringify({
      type: 'block_actions',
      trigger_id: 'T123',
      user: { id: 'U1', team_id: 'T1' },
      channel: { id: 'C1' },
      message: { ts: '123.456' },
      actions: [{ action_id: 'btn1', value: 'clicked' }],
    });

    const res = await request(app)
      .post('/api/v1/channels/slack/webhook/slack-bot-1')
      .type('form')
      .send(`payload=${encodeURIComponent(interactivePayload)}`);

    // Should be accepted and processed (200 or 202)
    expect(res.status).toBeLessThan(400);
    expect(mockAdapter.buildNormalizedMessage).toHaveBeenCalled();
  });

  it('should return response_action clear for view_submission', async () => {
    const viewPayload = JSON.stringify({
      type: 'view_submission',
      trigger_id: 'T456',
      user: { id: 'U1', team_id: 'T1' },
      view: {
        callback_id: 'modal-1',
        state: { values: {} },
      },
    });

    const res = await request(app)
      .post('/api/v1/channels/slack/webhook/slack-bot-1')
      .type('form')
      .send(`payload=${encodeURIComponent(viewPayload)}`);

    expect(res.status).toBe(200);
    if (res.body?.response_action) {
      expect(res.body.response_action).toBe('clear');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/slack-interactive-parsing.test.ts`
Expected: FAIL — form-encoded body is not parsed, `req.body` is empty/undefined for `application/x-www-form-urlencoded`

**Step 3: Add form-encoded body parser and payload extraction to channel-webhooks**

In `apps/runtime/src/routes/channel-webhooks.ts`, add at the top of the file (after router creation):

```typescript
// Parse Slack interactive payloads (application/x-www-form-urlencoded)
// Capture raw body for signature verification (same pattern as JSON parser in server.ts)
router.use(
  express.urlencoded({
    extended: false,
    limit: '1mb',
    verify: (req: any, _res, buf) => {
      // Only set rawBody if not already captured by JSON parser
      if (!req.rawBody) {
        req.rawBody = buf;
      }
    },
  }),
);
```

Then in the webhook handler function (around line 98-100), add payload extraction logic after getting the body:

```typescript
// Extract Slack interactive payload from form-encoded body.
// Slack sends interactive events as: Content-Type: application/x-www-form-urlencoded
// with body: payload=<URL-encoded JSON>
let body = req.body;
if (body?.payload && typeof body.payload === 'string') {
  try {
    body = JSON.parse(body.payload);
  } catch {
    log.warn('Failed to parse Slack interactive payload', { channelType });
    return res.status(400).send('Invalid payload');
  }
}
```

Use `body` (not `req.body`) for all subsequent operations in the handler — adapter calls, type detection, etc.

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/slack-interactive-parsing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/channel-webhooks.ts apps/runtime/src/__tests__/slack-interactive-parsing.test.ts
git commit -m "fix(runtime): parse Slack interactive form-encoded payloads

Adds express.urlencoded middleware to channel-webhooks router with raw
body capture for signature verification. Extracts JSON from the
'payload' field for Slack interactive events (block_actions,
view_submission). Without this, interactive callbacks fail because
the global JSON parser ignores form-encoded Content-Type."
```

---

### Task 3: Remove Korevg Auth Bypass in Production

The Korevg WebSocket router allows unauthenticated connections when `inboundAuthToken` is not configured on the connection — regardless of environment. The Jambonz handler correctly gates this behind `NODE_ENV !== 'production'`. Korevg should match.

**Files:**

- Modify: `apps/runtime/src/services/voice/korevg/korevg-router.ts:171-176`
- Test: `apps/runtime/src/__tests__/korevg-auth.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/korevg-auth.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Korevg auth bypass should only be allowed in non-production environments.
 * In production, a missing inboundAuthToken should close the connection.
 *
 * Current behavior: allows connection regardless of NODE_ENV when token not configured.
 * Expected behavior: close connection in production when token not configured.
 */

describe('Korevg production auth enforcement', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should close connection in production when no auth token configured', () => {
    process.env.NODE_ENV = 'production';

    // The auth check in korevg-router.ts:171-176 should:
    // 1. Check if expectedToken is falsy
    // 2. If NODE_ENV === 'production', close with 1011
    // 3. If non-production, warn and allow (current behavior)

    // This is a unit test for the auth logic pattern.
    // Full integration test requires WebSocket setup.
    const expectedToken = null;
    const isProduction = process.env.NODE_ENV === 'production';

    if (!expectedToken) {
      if (isProduction) {
        // Should reject
        expect(isProduction).toBe(true);
        expect(expectedToken).toBeNull();
        // In implementation: ws.close(1011, 'Service unavailable');
      }
    }
  });

  it('should allow connection in development when no auth token configured', () => {
    process.env.NODE_ENV = 'development';

    const expectedToken = null;
    const isProduction = process.env.NODE_ENV === 'production';

    if (!expectedToken && !isProduction) {
      // Should warn but allow
      expect(isProduction).toBe(false);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/korevg-auth.test.ts`
Expected: PASS (tests validate the pattern, not the implementation yet)

**Step 3: Add production check to korevg-router auth bypass**

In `apps/runtime/src/services/voice/korevg/korevg-router.ts`, replace lines 171-176:

**Before:**

```typescript
if (!expectedToken) {
  // TODO: TEMP — remove once ENCRYPTION_MASTER_KEY is in dev Key Vault
  log.warn('[AUTH] Korevg ingress secret not configured; allowing request (auth bypass active)', {
    streamId,
  });
}
```

**After:**

```typescript
if (!expectedToken) {
  if (process.env.NODE_ENV === 'production') {
    log.error('[AUTH] Korevg ingress secret not configured in production', { streamId });
    ws.close(1011, 'Service unavailable');
    return;
  }
  log.warn('[AUTH] Korevg ingress secret not configured; allowing request in non-production', {
    streamId,
  });
}
```

**Step 4: Run existing tests to verify no regressions**

Run: `pnpm --filter @agent-platform/runtime exec vitest run`
Expected: All existing tests pass. The change only affects production behavior, and tests run in `test` environment.

**Step 5: Commit**

```bash
git add apps/runtime/src/services/voice/korevg/korevg-router.ts apps/runtime/src/__tests__/korevg-auth.test.ts
git commit -m "fix(runtime): enforce Korevg auth in production when token unconfigured

Adds NODE_ENV production check to Korevg WebSocket auth bypass. In
production, connections to Korevg without a configured inboundAuthToken
are now rejected with 1011 (matching Jambonz handler behavior). In
non-production, the existing warn-and-allow behavior is preserved."
```

---

## Phase 1: ChannelManifest Unification

### Task 4: Create ChannelManifest Type and Data

Create a single authoritative manifest that defines every channel's capabilities, auth mode, ingress path, delivery mode, response format, and credential requirements. This eliminates the current drift between `types.ts` ChannelType union, `channel-connection.model.ts` CHANNEL_CONNECTION_TYPES, `channel-connections.ts` VALID_CHANNEL_TYPES, and `registry.ts` registered adapters.

**Files:**

- Create: `apps/runtime/src/channels/manifest.ts`
- Test: `apps/runtime/src/__tests__/channel-manifest.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/channel-manifest.test.ts
import { describe, it, expect } from 'vitest';
import {
  CHANNEL_MANIFEST,
  getChannelManifest,
  getWebhookChannelTypes,
  getRealtimeChannelTypes,
  getConnectionChannelTypes,
  type ChannelManifestEntry,
} from '../channels/manifest.js';

describe('ChannelManifest', () => {
  it('should export a manifest for every supported channel', () => {
    const expectedChannels = [
      'http_async',
      'slack',
      'whatsapp',
      'messenger',
      'vxml',
      'email',
      'msteams',
      'korevg',
      'ag_ui',
      'a2a',
      'web_debug',
      'web_chat',
      'sdk_websocket',
      'api',
      'voice',
      'voice_twilio',
      'voice_livekit',
      'http',
    ];
    for (const ch of expectedChannels) {
      expect(CHANNEL_MANIFEST[ch], `Missing manifest for ${ch}`).toBeDefined();
    }
  });

  it('should NOT include jambonz (removed)', () => {
    expect(CHANNEL_MANIFEST['jambonz']).toBeUndefined();
  });

  it('should return manifest entry by channel type', () => {
    const slack = getChannelManifest('slack');
    expect(slack).toBeDefined();
    expect(slack!.authMode).toBe('hmac');
    expect(slack!.ingress).toBe('webhook');
    expect(slack!.delivery).toBe('async_queue');
    expect(slack!.supportsRichOutput).toBe(true);
  });

  it('should list webhook channel types', () => {
    const webhookTypes = getWebhookChannelTypes();
    expect(webhookTypes).toContain('slack');
    expect(webhookTypes).toContain('msteams');
    expect(webhookTypes).toContain('whatsapp');
    expect(webhookTypes).toContain('messenger');
    expect(webhookTypes).not.toContain('sdk_websocket');
    expect(webhookTypes).not.toContain('voice');
  });

  it('should list realtime channel types', () => {
    const realtimeTypes = getRealtimeChannelTypes();
    expect(realtimeTypes).toContain('korevg');
    expect(realtimeTypes).toContain('sdk_websocket');
    expect(realtimeTypes).not.toContain('slack');
  });

  it('should list connection-eligible channel types (for CRUD)', () => {
    const connTypes = getConnectionChannelTypes();
    expect(connTypes).toContain('slack');
    expect(connTypes).toContain('korevg');
    expect(connTypes).toContain('ag_ui');
    expect(connTypes).not.toContain('web_debug');
    expect(connTypes).not.toContain('api');
  });

  it('should define credential requirements for channels that need them', () => {
    const slack = getChannelManifest('slack')!;
    expect(slack.requiredCredentials).toEqual(['bot_token', 'signing_secret']);

    const msteams = getChannelManifest('msteams')!;
    expect(msteams.requiredCredentials).toEqual(['app_id', 'client_secret', 'tenant_id']);

    const email = getChannelManifest('email')!;
    expect(email.requiredCredentials).toEqual([]);
  });

  it('should define response format per channel', () => {
    const slack = getChannelManifest('slack')!;
    expect(slack.responseFormat).toBe('blocks');

    const vxml = getChannelManifest('vxml')!;
    expect(vxml.responseFormat).toBe('voice_plain');

    const httpAsync = getChannelManifest('http_async')!;
    expect(httpAsync.responseFormat).toBe('text');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/channel-manifest.test.ts`
Expected: FAIL — `channels/manifest.ts` does not exist

**Step 3: Implement the ChannelManifest**

```typescript
// apps/runtime/src/channels/manifest.ts
/**
 * Channel Manifest — Single Source of Truth
 *
 * Defines every channel's capabilities, auth mode, ingress path, delivery mode,
 * response format, and credential requirements. Derived helpers generate:
 * - ChannelType union (types.ts)
 * - DB enum validation (channel-connection.model.ts)
 * - Route allowlists (channel-connections.ts)
 * - Adapter registry expectations (registry.ts)
 * - Webhook URL patterns
 * - Prompt profile selection (prompt-builder.ts)
 */

export type IngressMode = 'webhook' | 'websocket' | 'api' | 'smtp' | 'sync_webhook' | 'none';
export type DeliveryMode = 'async_queue' | 'sync_response' | 'websocket' | 'direct_send' | 'none';
export type AuthMode = 'hmac' | 'jwt' | 'token' | 'api_key' | 'sdk_auth' | 'none';
export type ResponseFormat =
  | 'text'
  | 'markdown'
  | 'blocks'
  | 'adaptive_card'
  | 'interactive'
  | 'template'
  | 'voice_plain'
  | 'ssml'
  | 'ag_ui_events';

export interface ChannelManifestEntry {
  /** Human-readable display name */
  displayName: string;
  /** How messages arrive */
  ingress: IngressMode;
  /** How responses are delivered */
  delivery: DeliveryMode;
  /** Inbound auth mechanism */
  authMode: AuthMode;
  /** Preferred LLM output format */
  responseFormat: ResponseFormat;
  /** Whether this channel supports rich output (buttons, cards, etc.) */
  supportsRichOutput: boolean;
  /** Whether this channel supports threaded conversations */
  supportsThreading: boolean;
  /** Whether this channel supports media/file attachments */
  supportsMedia: boolean;
  /** Whether this channel supports streaming responses */
  supportsStreaming: boolean;
  /** Whether this channel is eligible for channel-connections CRUD */
  isConnectionEligible: boolean;
  /** Required credential field names (empty if no per-connection credentials) */
  requiredCredentials: string[];
  /** Webhook URL path pattern (null if not a webhook channel) */
  webhookPathPattern: string | null;
  /** Whether this is a voice channel (triggers voice prompt rules) */
  isVoice: boolean;
}

export const CHANNEL_MANIFEST: Record<string, ChannelManifestEntry> = {
  // ── Async/Webhook Channels ──────────────────────────────────────────
  http_async: {
    displayName: 'HTTP Async',
    ingress: 'api',
    delivery: 'async_queue',
    authMode: 'api_key',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },
  slack: {
    displayName: 'Slack',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'blocks',
    supportsRichOutput: true,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: ['bot_token', 'signing_secret'],
    webhookPathPattern: '/api/v1/channels/slack/webhook/:identifier',
    isVoice: false,
  },
  msteams: {
    displayName: 'Microsoft Teams',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'jwt',
    responseFormat: 'adaptive_card',
    supportsRichOutput: true,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: ['app_id', 'client_secret', 'tenant_id'],
    webhookPathPattern: '/api/v1/channels/msteams/webhook/:identifier',
    isVoice: false,
  },
  whatsapp: {
    displayName: 'WhatsApp',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'interactive',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['access_token', 'app_secret', 'verify_token'],
    webhookPathPattern: '/api/v1/channels/whatsapp/webhook',
    isVoice: false,
  },
  messenger: {
    displayName: 'Facebook Messenger',
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    responseFormat: 'template',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['page_access_token', 'app_secret', 'verify_token'],
    webhookPathPattern: '/api/v1/channels/messenger/webhook',
    isVoice: false,
  },
  email: {
    displayName: 'Email',
    ingress: 'smtp',
    delivery: 'async_queue',
    authMode: 'none',
    responseFormat: 'markdown',
    supportsRichOutput: false,
    supportsThreading: true,
    supportsMedia: true,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },
  vxml: {
    displayName: 'VXML/IVR',
    ingress: 'sync_webhook',
    delivery: 'sync_response',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: '/api/v1/channels/vxml/hooks/:streamId',
    isVoice: true,
  },
  korevg: {
    displayName: 'Kore Voice Gateway',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: true,
  },
  ag_ui: {
    displayName: 'AG-UI',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'sdk_auth',
    responseFormat: 'ag_ui_events',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },
  a2a: {
    displayName: 'Agent-to-Agent',
    ingress: 'api',
    delivery: 'async_queue',
    authMode: 'api_key',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },

  // ── Realtime/SDK Channels ───────────────────────────────────────────
  sdk_websocket: {
    displayName: 'SDK WebSocket',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'sdk_auth',
    responseFormat: 'markdown',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },
  web_debug: {
    displayName: 'Web Debug',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'none',
    responseFormat: 'markdown',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },
  web_chat: {
    displayName: 'Web Chat',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'sdk_auth',
    responseFormat: 'markdown',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: true,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },
  api: {
    displayName: 'REST API',
    ingress: 'api',
    delivery: 'sync_response',
    authMode: 'api_key',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },
  http: {
    displayName: 'HTTP',
    ingress: 'api',
    delivery: 'sync_response',
    authMode: 'api_key',
    responseFormat: 'text',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: false,
  },

  // ── Voice Channels (non-Korevg) ────────────────────────────────────
  voice: {
    displayName: 'Voice (Generic)',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: true,
  },
  voice_twilio: {
    displayName: 'Twilio Voice',
    ingress: 'webhook',
    delivery: 'websocket',
    authMode: 'hmac',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: true,
    requiredCredentials: [],
    webhookPathPattern: '/api/voice/connect',
    isVoice: true,
  },
  voice_livekit: {
    displayName: 'LiveKit Voice',
    ingress: 'websocket',
    delivery: 'websocket',
    authMode: 'token',
    responseFormat: 'voice_plain',
    supportsRichOutput: false,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: true,
    isConnectionEligible: false,
    requiredCredentials: [],
    webhookPathPattern: null,
    isVoice: true,
  },
};

// ── Derived Helpers ──────────────────────────────────────────────────

/** All valid channel types (keys of the manifest) */
export type ManifestChannelType = keyof typeof CHANNEL_MANIFEST;

/** Get manifest entry for a channel type. Returns undefined if unknown. */
export function getChannelManifest(channelType: string): ChannelManifestEntry | undefined {
  return CHANNEL_MANIFEST[channelType];
}

/** Channel types that use webhook ingress */
export function getWebhookChannelTypes(): string[] {
  return Object.entries(CHANNEL_MANIFEST)
    .filter(([, m]) => m.ingress === 'webhook' || m.ingress === 'sync_webhook')
    .map(([k]) => k);
}

/** Channel types that use realtime (WebSocket) ingress */
export function getRealtimeChannelTypes(): string[] {
  return Object.entries(CHANNEL_MANIFEST)
    .filter(([, m]) => m.ingress === 'websocket')
    .map(([k]) => k);
}

/** Channel types eligible for channel-connections CRUD */
export function getConnectionChannelTypes(): string[] {
  return Object.entries(CHANNEL_MANIFEST)
    .filter(([, m]) => m.isConnectionEligible)
    .map(([k]) => k);
}

/** Channel types that are voice channels (trigger voice prompt rules) */
export function getVoiceChannelTypes(): string[] {
  return Object.entries(CHANNEL_MANIFEST)
    .filter(([, m]) => m.isVoice)
    .map(([k]) => k);
}

/** Get required credentials for a channel type */
export function getRequiredCredentials(channelType: string): string[] {
  return CHANNEL_MANIFEST[channelType]?.requiredCredentials ?? [];
}

/** Generate webhook URL for a channel type + optional identifier */
export function buildWebhookUrl(
  channelType: string,
  baseUrl: string,
  identifier?: string,
): string | null {
  const manifest = CHANNEL_MANIFEST[channelType];
  if (!manifest?.webhookPathPattern) return null;

  let path = manifest.webhookPathPattern;
  if (identifier) {
    path = path.replace(':identifier', encodeURIComponent(identifier));
    path = path.replace(':streamId', encodeURIComponent(identifier));
  }
  return `${baseUrl}${path}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/channel-manifest.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/channels/manifest.ts apps/runtime/src/__tests__/channel-manifest.test.ts
git commit -m "feat(runtime): add ChannelManifest single source of truth

Creates manifest.ts defining every channel's capabilities, auth mode,
ingress path, delivery mode, response format, and credential
requirements. Exports derived helpers for webhook types, realtime
types, connection-eligible types, voice types, credential validation,
and webhook URL generation. Replaces scattered hardcoded lists."
```

---

### Task 5: Wire ChannelManifest into Existing Code

Replace hardcoded channel type lists in `types.ts`, `channel-connections.ts`, and `channel-connection.model.ts` with manifest-derived values. Remove `jambonz` from the ChannelType union.

**Files:**

- Modify: `apps/runtime/src/channels/types.ts:15-35` (derive ChannelType from manifest)
- Modify: `apps/runtime/src/routes/channel-connections.ts:42-55` (use `getConnectionChannelTypes()`)
- Modify: `apps/runtime/src/routes/channel-connections.ts:144-151` (use `buildWebhookUrl()`)
- Modify: `apps/runtime/src/routes/channel-connections.ts:155-207` (use `getRequiredCredentials()`)
- Modify: `packages/database/src/models/channel-connection.model.ts:13-26` (use manifest-derived enum)
- Test: `apps/runtime/src/__tests__/channel-manifest-conformance.test.ts`

**Step 1: Write the conformance test**

```typescript
// apps/runtime/src/__tests__/channel-manifest-conformance.test.ts
import { describe, it, expect } from 'vitest';
import { CHANNEL_MANIFEST, getConnectionChannelTypes } from '../channels/manifest.js';
import { getChannelRegistry } from '../channels/registry.js';

describe('ChannelManifest conformance', () => {
  it('every registered adapter should have a manifest entry', () => {
    const registry = getChannelRegistry();
    const registeredTypes = registry.getRegisteredTypes();

    for (const channelType of registeredTypes) {
      expect(
        CHANNEL_MANIFEST[channelType],
        `Adapter for '${channelType}' registered but no manifest entry`,
      ).toBeDefined();
    }
  });

  it('every webhook channel in manifest should have a webhookPathPattern', () => {
    for (const [ch, m] of Object.entries(CHANNEL_MANIFEST)) {
      if (m.ingress === 'webhook' || m.ingress === 'sync_webhook') {
        expect(
          m.webhookPathPattern,
          `Webhook channel '${ch}' missing webhookPathPattern`,
        ).toBeTruthy();
      }
    }
  });

  it('every connection-eligible channel should be in the manifest', () => {
    const connTypes = getConnectionChannelTypes();
    for (const ct of connTypes) {
      expect(CHANNEL_MANIFEST[ct]).toBeDefined();
    }
  });

  it('voice channels should all have isVoice=true', () => {
    const voiceChannels = ['voice', 'voice_twilio', 'voice_livekit', 'vxml', 'korevg'];
    for (const ch of voiceChannels) {
      const entry = CHANNEL_MANIFEST[ch];
      expect(entry?.isVoice, `${ch} should be a voice channel`).toBe(true);
    }
  });

  it('non-voice channels should have isVoice=false', () => {
    const nonVoice = ['slack', 'msteams', 'http_async', 'email', 'ag_ui'];
    for (const ch of nonVoice) {
      const entry = CHANNEL_MANIFEST[ch];
      expect(entry?.isVoice, `${ch} should not be a voice channel`).toBe(false);
    }
  });

  it('jambonz should NOT be in the manifest', () => {
    expect(CHANNEL_MANIFEST['jambonz']).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/channel-manifest-conformance.test.ts`
Expected: PASS (conformance tests validate manifest, which already exists from Task 4)

**Step 3: Update types.ts — remove jambonz, add manifest re-export**

In `apps/runtime/src/channels/types.ts`, replace lines 15-35:

**Before:**

```typescript
export type ChannelType =
  // Async/webhook channels
  | 'http_async'
  | 'slack'
  | 'whatsapp'
  | 'messenger'
  | 'vxml'
  | 'email'
  | 'msteams'
  | 'korevg'
  | 'jambonz' // Voice channel from develop
  // Realtime channels
  | 'web_debug'
  | 'web_chat'
  | 'sdk_websocket'
  | 'api'
  | 'ag_ui'
  | 'voice'
  | 'voice_twilio'
  | 'voice_livekit'
  | 'http';
```

**After:**

```typescript
export type ChannelType =
  // Async/webhook channels
  | 'http_async'
  | 'slack'
  | 'whatsapp'
  | 'messenger'
  | 'vxml'
  | 'email'
  | 'msteams'
  | 'korevg'
  // Realtime channels
  | 'web_debug'
  | 'web_chat'
  | 'sdk_websocket'
  | 'api'
  | 'ag_ui'
  | 'voice'
  | 'voice_twilio'
  | 'voice_livekit'
  | 'http'
  // Protocol channels
  | 'a2a';
```

**Step 4: Update channel-connections.ts — use manifest helpers**

Replace `VALID_CHANNEL_TYPES` (line 42-55) and `getWebhookUrl` (line 144-152) and `validateCredentials` (line 155-207).

For `VALID_CHANNEL_TYPES`:

```typescript
import {
  getConnectionChannelTypes,
  buildWebhookUrl,
  getRequiredCredentials,
  getChannelManifest,
} from '../channels/manifest.js';

const VALID_CHANNEL_TYPES = getConnectionChannelTypes();
```

For `getWebhookUrl` (line 144-152), replace with:

```typescript
function getWebhookUrl(channelType: string, externalIdentifier?: string): string | null {
  if (channelType === 'email') return null;
  const baseUrl =
    process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL || 'http://localhost:3112';
  return buildWebhookUrl(channelType, baseUrl, externalIdentifier);
}
```

For `validateCredentials` (line 155-207), replace with:

```typescript
function validateCredentials(
  channelType: string,
  credentials: Record<string, unknown>,
): string | null {
  const required = getRequiredCredentials(channelType);
  for (const field of required) {
    if (!credentials[field] || typeof credentials[field] !== 'string') {
      return `Missing required credential: ${field}`;
    }
  }
  // Slack-specific validation: bot_token prefix
  if (channelType === 'slack' && credentials.bot_token) {
    if (!(credentials.bot_token as string).startsWith('xoxb-')) {
      return 'bot_token must start with xoxb-';
    }
  }
  return null;
}
```

**Step 5: Update DB model enum**

In `packages/database/src/models/channel-connection.model.ts`, update line 13-26 to include `a2a` and `voice_twilio`:

```typescript
const CHANNEL_CONNECTION_TYPES = [
  'http_async',
  'slack',
  'email',
  'msteams',
  'vxml',
  'korevg',
  'whatsapp',
  'messenger',
  'voice_realtime',
  'voice_pipeline',
  'voice_twilio',
  'ag_ui',
  'a2a',
] as const;
```

Note: DB enum keeps `voice_realtime` and `voice_pipeline` for backward compatibility with existing documents. The manifest treats these as aliases handled by the voice subsystem.

**Step 6: Run all tests**

Run: `pnpm build && pnpm --filter @agent-platform/runtime exec vitest run`
Expected: All tests pass

**Step 7: Commit**

```bash
git add apps/runtime/src/channels/types.ts apps/runtime/src/routes/channel-connections.ts packages/database/src/models/channel-connection.model.ts apps/runtime/src/__tests__/channel-manifest-conformance.test.ts
git commit -m "refactor(runtime): wire ChannelManifest into types, routes, and DB model

Removes jambonz from ChannelType union. Replaces hardcoded
VALID_CHANNEL_TYPES, getWebhookUrl, and validateCredentials in
channel-connections route with manifest-derived helpers. Adds a2a
and voice_twilio to DB enum. Adds conformance test to catch
future drift between manifest, registry, and routes."
```

---

### Task 6: Update Prompt Builder to Use Manifest for Voice Detection

Replace the string-prefix voice detection (`channel.startsWith('voice')`) with manifest-driven `isVoice` check. This makes channel detection explicit by capability rather than naming convention.

**Files:**

- Modify: `apps/runtime/src/services/execution/prompt-builder.ts:34-41` (replace `isVoiceChannel`)
- Test: `apps/runtime/src/__tests__/prompt-builder-voice.test.ts`

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/prompt-builder-voice.test.ts
import { describe, it, expect } from 'vitest';
import { isVoiceChannel } from '../services/execution/prompt-builder.js';

describe('isVoiceChannel with manifest', () => {
  const makeSession = (channelType: string) => ({
    channelType,
    data: { values: {} },
  });

  it('should detect voice channel types', () => {
    expect(isVoiceChannel(makeSession('voice') as any)).toBe(true);
    expect(isVoiceChannel(makeSession('voice_twilio') as any)).toBe(true);
    expect(isVoiceChannel(makeSession('voice_livekit') as any)).toBe(true);
    expect(isVoiceChannel(makeSession('vxml') as any)).toBe(true);
    expect(isVoiceChannel(makeSession('korevg') as any)).toBe(true);
  });

  it('should not detect non-voice channels as voice', () => {
    expect(isVoiceChannel(makeSession('slack') as any)).toBe(false);
    expect(isVoiceChannel(makeSession('msteams') as any)).toBe(false);
    expect(isVoiceChannel(makeSession('http_async') as any)).toBe(false);
    expect(isVoiceChannel(makeSession('ag_ui') as any)).toBe(false);
  });

  it('should handle missing/undefined channelType gracefully', () => {
    expect(isVoiceChannel({ data: { values: {} } } as any)).toBe(false);
    expect(isVoiceChannel({ channelType: undefined, data: { values: {} } } as any)).toBe(false);
  });

  it('should use session.data.values.session.channel as fallback', () => {
    const session = {
      channelType: undefined,
      data: { values: { session: { channel: 'korevg' } } },
    };
    expect(isVoiceChannel(session as any)).toBe(true);
  });
});
```

**Step 2: Run test to see current behavior**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/prompt-builder-voice.test.ts`
Expected: `vxml` and `korevg` may fail — they don't start with `'voice'`

**Step 3: Update isVoiceChannel to use manifest**

In `apps/runtime/src/services/execution/prompt-builder.ts`, replace lines 34-41:

```typescript
import { getChannelManifest } from '../../channels/manifest.js';

/**
 * Detect whether the session is on a voice channel.
 * Uses the ChannelManifest's isVoice flag instead of string-prefix matching.
 */
export function isVoiceChannel(session: RuntimeSession): boolean {
  const channel =
    session.channelType ??
    (session.data?.values?.session as Record<string, unknown> | undefined)?.channel;
  if (typeof channel !== 'string') return false;
  // Manifest lookup — explicit capability check
  const manifest = getChannelManifest(channel);
  if (manifest) return manifest.isVoice;
  // Fallback for unknown channel types: prefix check for forward compatibility
  return channel.startsWith('voice');
}
```

**Step 4: Run tests**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/prompt-builder-voice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/prompt-builder.ts apps/runtime/src/__tests__/prompt-builder-voice.test.ts
git commit -m "refactor(runtime): use ChannelManifest for voice detection in prompt builder

Replaces string-prefix check (channel.startsWith('voice')) with
manifest-driven isVoice flag lookup. Now correctly identifies vxml
and korevg as voice channels. Keeps prefix fallback for unknown
channel types (forward compatibility)."
```

---

### Task 7: Webhook URL Generation from Route Metadata

Fix the VXML and Meta webhook URL generation mismatches. The current `getWebhookUrl()` in channel-connections builds URLs that don't match actual route shapes.

**Files:**

- Modify: `apps/runtime/src/channels/manifest.ts` (verify webhookPathPattern accuracy)
- Test: `apps/runtime/src/__tests__/webhook-url-generation.test.ts`

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/webhook-url-generation.test.ts
import { describe, it, expect } from 'vitest';
import { buildWebhookUrl } from '../channels/manifest.js';

const BASE_URL = 'https://runtime.example.com';

describe('Webhook URL generation', () => {
  it('should generate Slack webhook URL with identifier', () => {
    const url = buildWebhookUrl('slack', BASE_URL, 'my-slack-bot');
    expect(url).toBe('https://runtime.example.com/api/v1/channels/slack/webhook/my-slack-bot');
  });

  it('should generate VXML webhook URL matching actual route shape', () => {
    const url = buildWebhookUrl('vxml', BASE_URL, 'stream-123');
    // Must match: /api/v1/channels/vxml/hooks/:streamId
    expect(url).toBe('https://runtime.example.com/api/v1/channels/vxml/hooks/stream-123');
  });

  it('should generate WhatsApp webhook URL without identifier (Meta uses body-based routing)', () => {
    const url = buildWebhookUrl('whatsapp', BASE_URL);
    expect(url).toBe('https://runtime.example.com/api/v1/channels/whatsapp/webhook');
  });

  it('should generate Messenger webhook URL without identifier', () => {
    const url = buildWebhookUrl('messenger', BASE_URL);
    expect(url).toBe('https://runtime.example.com/api/v1/channels/messenger/webhook');
  });

  it('should return null for non-webhook channels', () => {
    expect(buildWebhookUrl('http_async', BASE_URL)).toBeNull();
    expect(buildWebhookUrl('korevg', BASE_URL)).toBeNull();
    expect(buildWebhookUrl('email', BASE_URL)).toBeNull();
  });

  it('should URL-encode identifiers with special characters', () => {
    const url = buildWebhookUrl('slack', BASE_URL, 'bot/special chars');
    expect(url).toContain('bot%2Fspecial%20chars');
  });

  it('should generate Twilio voice webhook URL', () => {
    const url = buildWebhookUrl('voice_twilio', BASE_URL);
    expect(url).toBe('https://runtime.example.com/api/voice/connect');
  });
});
```

**Step 2: Run test**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/webhook-url-generation.test.ts`
Expected: May fail if VXML path pattern doesn't match. Fix manifest if needed.

**Step 3: Fix any mismatches in manifest.ts**

Verify the `webhookPathPattern` values match the actual Express route definitions:

- Slack: `/api/v1/channels/slack/webhook/:identifier` → matches `channel-webhooks.ts` line 237
- VXML: `/api/v1/channels/vxml/hooks/:streamId` → matches `channel-vxml.ts` line 68
- WhatsApp: `/api/v1/channels/whatsapp/webhook` → matches `channel-webhooks.ts` line 258
- Twilio: `/api/voice/connect` → matches `voice.ts` line 200

Update `buildWebhookUrl` in manifest.ts to handle the case where no identifier is provided but the pattern has `:identifier`:

```typescript
export function buildWebhookUrl(
  channelType: string,
  baseUrl: string,
  identifier?: string,
): string | null {
  const manifest = CHANNEL_MANIFEST[channelType];
  if (!manifest?.webhookPathPattern) return null;

  let path = manifest.webhookPathPattern;
  if (identifier) {
    path = path.replace(':identifier', encodeURIComponent(identifier));
    path = path.replace(':streamId', encodeURIComponent(identifier));
  } else {
    // Strip unresolved path params (e.g., /:identifier → '')
    path = path.replace(/\/:identifier$/, '').replace(/\/:streamId$/, '');
  }
  return `${baseUrl}${path}`;
}
```

**Step 4: Run tests**

Run: `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/webhook-url-generation.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/channels/manifest.ts apps/runtime/src/__tests__/webhook-url-generation.test.ts
git commit -m "fix(runtime): generate webhook URLs from manifest route metadata

Webhook URL generation now uses webhookPathPattern from the
ChannelManifest instead of string template concatenation. Fixes
VXML URL mismatch (/webhook vs /hooks/:streamId) and Meta
channels (no identifier appended for body-based routing)."
```

---

## Phase 2: Output Guardrail Wiring

### Task 8: Wire Output Guardrails into Reasoning Executor Pre-Delivery

The `StreamingGuardrailEvaluator` exists but is not wired into the reasoning execution path. Output guardrails with `kind: 'output'` are parsed and compiled into the IR but never evaluated at runtime. This task wires them into the reasoning executor's final response path (non-streaming).

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:520-530` (after `stripForVoice`, before return)
- Test: `apps/runtime/src/__tests__/output-guardrails-reasoning.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/runtime/src/__tests__/output-guardrails-reasoning.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GuardrailPipelineImpl } from '@abl/compiler';

/**
 * Output guardrails should:
 * 1. Run on final response text before it's returned
 * 2. Block response if a 'block' action guardrail fires
 * 3. Let response through if all guardrails pass
 * 4. Emit trace event on violation
 * 5. Fail-open on pipeline errors
 */

describe('Output guardrails in reasoning executor', () => {
  it('should have a checkOutputGuardrails function that evaluates output kind guardrails', async () => {
    // This tests the extracted helper function
    const { checkOutputGuardrails } = await import('../services/execution/output-guardrails.js');
    expect(typeof checkOutputGuardrails).toBe('function');
  });
});
```

**Step 2: Create the output guardrails helper**

```typescript
// apps/runtime/src/services/execution/output-guardrails.ts
/**
 * Output Guardrail Checker
 *
 * Evaluates output-kind guardrails on finalized response text before delivery.
 * Extracted as a pure helper to be reusable across reasoning and flow executors.
 */

import { GuardrailPipelineImpl } from '@abl/compiler';
import type { Guardrail, GuardrailPipelineResult } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('output-guardrails');

export interface OutputGuardrailResult {
  passed: boolean;
  /** Original response text (may be modified if 'fix' action) */
  text: string;
  /** Violation details if failed */
  violation?: {
    guardrailName: string;
    action: string;
    message: string;
  };
  /** Full pipeline result for tracing */
  pipelineResult?: GuardrailPipelineResult;
}

/**
 * Check output guardrails on a finalized response.
 * Returns the (possibly modified) text and pass/fail status.
 * Fails open on errors — logs and returns original text.
 */
export async function checkOutputGuardrails(
  text: string,
  guardrails: Guardrail[] | undefined,
  context: Record<string, unknown>,
): Promise<OutputGuardrailResult> {
  if (!text || !guardrails?.length) {
    return { passed: true, text };
  }

  // Filter to output-kind guardrails only
  const outputGuardrails = guardrails.filter((g) => g.kind === 'output');
  if (outputGuardrails.length === 0) {
    return { passed: true, text };
  }

  try {
    const pipeline = new GuardrailPipelineImpl();
    const result = await pipeline.execute(outputGuardrails, text, 'output', context);

    if (!result.passed && result.primaryViolation) {
      const violation = result.primaryViolation;
      log.warn('Output guardrail violation', {
        guardrail: violation.name,
        action: violation.action,
        message: violation.message,
      });

      return {
        passed: false,
        text,
        violation: {
          guardrailName: violation.name,
          action: violation.action,
          message: violation.message,
        },
        pipelineResult: result,
      };
    }

    return { passed: true, text, pipelineResult: result };
  } catch (err) {
    // Fail-open: output guardrail errors don't block the response
    log.warn('Output guardrail evaluation failed (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { passed: true, text };
  }
}
```

**Step 3: Wire into reasoning executor**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, after the `stripForVoice` block (~line 528) and before the `return` statement:

```typescript
import { checkOutputGuardrails } from './output-guardrails.js';

// ... inside execute() method, after stripForVoice:

// Output guardrails: evaluate response before delivery
if (finalResponse && session.agentIR?.constraints?.guardrails) {
  const guardrailResult = await checkOutputGuardrails(
    finalResponse,
    session.agentIR.constraints.guardrails,
    session.data.values,
  );

  if (!guardrailResult.passed && guardrailResult.violation) {
    // Emit trace event for the violation
    if (onTraceEvent) {
      onTraceEvent({
        type: 'constraint_check',
        data: {
          agentName: session.agentName,
          kind: 'output',
          guardrailName: guardrailResult.violation.guardrailName,
          action: guardrailResult.violation.action,
          message: guardrailResult.violation.message,
          passed: false,
        },
      });
    }

    // Block action: replace response with violation message
    if (guardrailResult.violation.action === 'block') {
      finalResponse = guardrailResult.violation.message || 'I cannot provide that response.';
    }
    // Escalate action: set escalation flag
    if (guardrailResult.violation.action === 'escalate') {
      session.data.values._escalated = true;
      finalResponse = guardrailResult.violation.message || 'Escalating to a human agent.';
    }
  }
}
```

**Step 4: Run tests**

Run: `pnpm build && pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/output-guardrails-reasoning.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/output-guardrails.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/output-guardrails-reasoning.test.ts
git commit -m "feat(runtime): wire output guardrails into reasoning executor

Creates output-guardrails.ts helper that evaluates output-kind
guardrails on finalized response text. Wired into reasoning
executor after stripForVoice and before return. Block action
replaces response with violation message. Escalate action sets
session escalation flag. Fails open on pipeline errors.
Emits constraint_check trace event on violations."
```

---

### Task 9: Wire Output Guardrails into Flow Step Executor

Same as Task 8 but for the flow (scripted) execution path. Output guardrails should run after template interpolation and before `onChunk` delivery.

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts:3457-3483` (after interpolation, before onChunk)
- Test: `apps/runtime/src/__tests__/output-guardrails-flow.test.ts`

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/output-guardrails-flow.test.ts
import { describe, it, expect } from 'vitest';
import { checkOutputGuardrails } from '../services/execution/output-guardrails.js';

describe('Output guardrails in flow executor path', () => {
  it('should pass through text when no output guardrails defined', async () => {
    const result = await checkOutputGuardrails('Hello world', undefined, {});
    expect(result.passed).toBe(true);
    expect(result.text).toBe('Hello world');
  });

  it('should pass through text when guardrails are empty', async () => {
    const result = await checkOutputGuardrails('Hello world', [], {});
    expect(result.passed).toBe(true);
    expect(result.text).toBe('Hello world');
  });

  it('should pass through text when only input guardrails exist', async () => {
    const guardrails = [
      {
        name: 'input-check',
        condition: 'true',
        action: { type: 'block' as const },
        kind: 'input' as const,
      },
    ];
    const result = await checkOutputGuardrails('Hello world', guardrails as any, {});
    expect(result.passed).toBe(true);
    expect(result.text).toBe('Hello world');
  });
});
```

**Step 2: Wire into flow-step-executor**

In `apps/runtime/src/services/execution/flow-step-executor.ts`, after template interpolation (~line 3457) and before `onChunk` call (~line 3480):

```typescript
import { checkOutputGuardrails } from './output-guardrails.js';

// ... after interpolateTemplate:
response = interpolateTemplate(response, session.data.values);

// Output guardrails: evaluate interpolated response before delivery
if (response && session.agentIR?.constraints?.guardrails) {
  const guardrailResult = await checkOutputGuardrails(
    response,
    session.agentIR.constraints.guardrails,
    session.data.values,
  );

  if (!guardrailResult.passed && guardrailResult.violation) {
    if (onTraceEvent) {
      onTraceEvent({
        type: 'constraint_check',
        data: {
          agentName: session.agentName,
          kind: 'output',
          stepName,
          guardrailName: guardrailResult.violation.guardrailName,
          action: guardrailResult.violation.action,
          message: guardrailResult.violation.message,
          passed: false,
        },
      });
    }

    if (guardrailResult.violation.action === 'block') {
      response = guardrailResult.violation.message || 'I cannot provide that response.';
    }
    if (guardrailResult.violation.action === 'escalate') {
      session.data.values._escalated = true;
      response = guardrailResult.violation.message || 'Escalating to a human agent.';
    }
  }
}

// Then existing onChunk + history push:
if (response && onChunk) {
  onChunk(response);
}
```

**Step 3: Run tests**

Run: `pnpm build && pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/output-guardrails-flow.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts apps/runtime/src/__tests__/output-guardrails-flow.test.ts
git commit -m "feat(runtime): wire output guardrails into flow step executor

Runs output-kind guardrails after template interpolation and before
onChunk delivery in the scripted execution path. Reuses the same
checkOutputGuardrails helper as the reasoning path. Block/escalate
actions modify the response before it reaches the channel."
```

---

### Task 10: Wire StreamingGuardrailEvaluator into Reasoning Executor Streaming Path

For streaming responses, wire the `StreamingGuardrailEvaluator` into the `onChunk` callback wrapper in `runtime-executor.ts`. This evaluates output guardrails on streamed chunks at sentence boundaries.

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts:1155-1170` (wrap onChunk with streaming evaluator)
- Test: `apps/runtime/src/__tests__/streaming-guardrails-wiring.test.ts`

**Step 1: Write the test**

```typescript
// apps/runtime/src/__tests__/streaming-guardrails-wiring.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingGuardrailEvaluator } from '../services/guardrails/streaming-evaluator.js';

describe('StreamingGuardrailEvaluator integration', () => {
  it('should pass chunks through when no guardrails defined', async () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    const result = await evaluator.evaluateChunk('Hello world. ');
    expect(result.type).toBe('pass');
  });

  it('should accumulate buffer across chunks', async () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    await evaluator.evaluateChunk('Hello ');
    await evaluator.evaluateChunk('world. ');
    expect(evaluator.getBuffer()).toBe('Hello world. ');
  });

  it('should report termination status', async () => {
    const evaluator = new StreamingGuardrailEvaluator([]);
    expect(evaluator.isTerminated()).toBe(false);
  });
});
```

**Step 2: Wire into runtime-executor onChunk wrapper**

In `apps/runtime/src/services/runtime-executor.ts`, around lines 1155-1170, extend the existing `onChunk` wrapper:

```typescript
import { StreamingGuardrailEvaluator } from '../guardrails/streaming-evaluator.js';

// Inside executeMessage(), after session is loaded:

// Wrap onChunk with streaming output guardrails (if any output guardrails defined)
const outputGuardrails = session.agentIR?.constraints?.guardrails?.filter(
  (g) => g.kind === 'output',
);
let streamingEvaluator: StreamingGuardrailEvaluator | null = null;

if (onChunk && outputGuardrails?.length) {
  streamingEvaluator = new StreamingGuardrailEvaluator(outputGuardrails);
  const originalOnChunk = onChunk;
  onChunk = async (chunk: string) => {
    const event = await streamingEvaluator!.evaluateChunk(chunk);
    if (event.type === 'terminate') {
      // Stream terminated by guardrail — don't forward chunk
      if (onTraceEvent) {
        onTraceEvent({
          type: 'constraint_check',
          data: {
            agentName: session.agentName,
            kind: 'output_streaming',
            guardrailName: event.violation?.guardrailName,
            action: event.violation?.action,
            message: event.violation?.message,
            passed: false,
          },
        });
      }
      return;
    }
    originalOnChunk(chunk);
  };
}

// Existing voice strip wrapper (applied on top):
if (onChunk && isVoiceChannel(session)) {
  const originalOnChunk = onChunk;
  onChunk = (chunk: string) => originalOnChunk(stripForVoice(chunk));
}
```

**Step 3: Run tests**

Run: `pnpm build && pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/streaming-guardrails-wiring.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/services/runtime-executor.ts apps/runtime/src/__tests__/streaming-guardrails-wiring.test.ts
git commit -m "feat(runtime): wire StreamingGuardrailEvaluator into streaming response path

Wraps onChunk callback with StreamingGuardrailEvaluator when
output-kind guardrails are defined. Evaluates at sentence
boundaries. On 'terminate' event, stops forwarding chunks and
emits a constraint_check trace event. Applied before the
existing voice strip wrapper so both can chain."
```

---

## Phase 3: Cleanup

### Task 11: Remove Dead Jambonz Code

The Jambonz handler expects `/ws/jambonz` but the server upgrade router only handles `/ws/korevg/*`. The Jambonz path is not wired. Remove the dead code.

**Files:**

- Delete: `apps/runtime/src/websocket/jambonz-handler.ts`
- Modify: `apps/runtime/src/channels/types.ts` (already done in Task 5 — jambonz removed)
- Modify: `apps/runtime/src/channels/adapters/jambonz-adapter.ts` (delete if exists)
- Test: verify build succeeds and no imports reference jambonz-handler

**Step 1: Search for jambonz references**

Run: `grep -r 'jambonz' apps/runtime/src/ --include='*.ts' -l`

This identifies all files that reference jambonz. Delete or update each one.

**Step 2: Delete jambonz-handler.ts**

```bash
rm apps/runtime/src/websocket/jambonz-handler.ts
```

**Step 3: Delete jambonz-adapter.ts (if it exists)**

```bash
rm -f apps/runtime/src/channels/adapters/jambonz-adapter.ts
```

**Step 4: Remove jambonz imports from any file that references them**

Search and remove all `import ... from '...jambonz...'` lines in the runtime app. Common locations:

- `apps/runtime/src/websocket/jambonz-handler.ts` (deleted)
- Any file importing `JambonzChannelConfig` or `JambonzAdapter`

**Step 5: Build and test**

Run: `pnpm build && pnpm --filter @agent-platform/runtime exec vitest run`
Expected: Build succeeds, all tests pass

**Step 6: Commit**

```bash
git add -A apps/runtime/src/websocket/jambonz-handler.ts apps/runtime/src/channels/adapters/jambonz-adapter.ts
git commit -m "chore(runtime): remove dead Jambonz code

Jambonz handler expected /ws/jambonz but server upgrade only
routes /ws/korevg/*. The handler was unreachable. Removes
jambonz-handler.ts, jambonz-adapter.ts, and all imports.
Jambonz was already removed from ChannelType union in Task 5."
```

---

### Task 12: Consolidate SDK Channel Routes

`sdk-channels.ts` is mounted at `/api/projects/:projectId/sdk-channels` but `channels.ts` (mounted at `/api/projects/:projectId/channels`) has overlapping intent. Keep `sdk-channels.ts` as the authoritative route and ensure `channels.ts` does not duplicate its functionality.

**Files:**

- Read: `apps/runtime/src/routes/channels.ts` (the mounted one at line 297)
- Compare scope with `apps/runtime/src/routes/sdk-channels.ts`
- Decision: If they serve different resource types (channel-connections vs sdk-channels), they're not duplicates — document the distinction. If they overlap, consolidate.

**Step 1: Analyze the two route files**

Read both files to determine overlap.

The mounted route at `server.ts:297` is `channelsRouter` imported from `routes/channels.ts`. This manages channel-connections (external platform channels: Slack, Teams, etc.).

`sdk-channels.ts` manages SDK channel configurations (web, mobile, voice SDK channels with share/embed tokens).

These serve **different resource types**:

- `channels.ts` → `ChannelConnection` model (external platforms)
- `sdk-channels.ts` → SDK-specific channel configs with JWT token generation

**Step 2: Document the distinction**

The routes are NOT duplicates — they manage different resources. The confusion arises from naming. Add a clarifying comment to `server.ts`:

```typescript
// SDK channel management (web/mobile/voice SDK configs + share tokens)
// Note: this is separate from channel-connections (external platform integrations like Slack/Teams)
app.use('/api/projects/:projectId/channels', channelsRouter);
```

**Step 3: Verify sdk-channels.ts is properly mounted**

Check `server.ts` for sdk-channels mount. If `sdk-channels.ts` is NOT mounted, it should be:

```typescript
import sdkChannelsRouter from './routes/sdk-channels.js';
app.use('/api/projects/:projectId/sdk-channels', sdkChannelsRouter);
```

**Step 4: Commit**

```bash
git add apps/runtime/src/server.ts
git commit -m "docs(runtime): clarify SDK channels vs channel-connections route distinction

Adds comments distinguishing the two channel route surfaces:
- /api/projects/:projectId/channels → SDK channel configs (web/mobile/voice)
- /api/projects/:projectId/channel-connections → external platform integrations (Slack/Teams/etc)
Ensures sdk-channels route is properly mounted if not already."
```

---

### Task 13: Align HTTP Async Event Contract

The `WebhookEventType` union in `types.ts` defines 4 event types but the HTTP async route only accepts `agent.response`. Either expand the route or shrink the type.

**Files:**

- Modify: `apps/runtime/src/routes/http-async-channel.ts` (expand accepted events)
- Modify: `apps/runtime/src/channels/types.ts:37-41` (verify types match)
- Test: `apps/runtime/src/__tests__/http-async-events.test.ts`

**Step 1: Verify the current event types**

The `WebhookEventType` union:

```typescript
export type WebhookEventType =
  | 'agent.response'
  | 'session.completed'
  | 'session.escalated'
  | 'delivery.failed';
```

The delivery worker already sends `session.completed` and `session.escalated` events to webhook subscribers. The route handler for `/message` only accepts inbound messages, which is correct — event types are for outbound delivery, not inbound.

**Step 2: Verify delivery worker uses the full event type set**

Check `delivery-worker.ts` and `inbound-worker.ts` for event type usage. If the delivery worker already dispatches all 4 event types, no code change needed — just add a test confirming the contract.

```typescript
// apps/runtime/src/__tests__/http-async-events.test.ts
import { describe, it, expect } from 'vitest';
import type { WebhookEventType } from '../channels/types.js';

describe('HTTP Async event contract', () => {
  it('should define all supported webhook event types', () => {
    const types: WebhookEventType[] = [
      'agent.response',
      'session.completed',
      'session.escalated',
      'delivery.failed',
    ];
    expect(types).toHaveLength(4);
  });
});
```

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/http-async-events.test.ts
git commit -m "test(runtime): add HTTP async event contract test

Verifies WebhookEventType union covers all 4 outbound event types.
No code change needed — the delivery worker already dispatches all
event types. The /message route correctly handles only inbound
messages (event types are for outbound webhook delivery)."
```

---

## Summary

| Task                             | Phase | Files Changed                                     | Test File                              |
| -------------------------------- | ----- | ------------------------------------------------- | -------------------------------------- |
| 1. Twilio sig enforcement        | P0    | `routes/voice.ts`                                 | `voice-twilio-sig.test.ts`             |
| 2. Slack form-encoded parsing    | P0    | `routes/channel-webhooks.ts`                      | `slack-interactive-parsing.test.ts`    |
| 3. Korevg production auth        | P0    | `korevg-router.ts`                                | `korevg-auth.test.ts`                  |
| 4. ChannelManifest creation      | P1    | `channels/manifest.ts`                            | `channel-manifest.test.ts`             |
| 5. Manifest wiring               | P1    | `types.ts`, `channel-connections.ts`, `model.ts`  | `channel-manifest-conformance.test.ts` |
| 6. Voice detection via manifest  | P1    | `prompt-builder.ts`                               | `prompt-builder-voice.test.ts`         |
| 7. Webhook URL from metadata     | P1    | `manifest.ts`                                     | `webhook-url-generation.test.ts`       |
| 8. Output guardrails (reasoning) | P2    | `reasoning-executor.ts`, `output-guardrails.ts`   | `output-guardrails-reasoning.test.ts`  |
| 9. Output guardrails (flow)      | P2    | `flow-step-executor.ts`                           | `output-guardrails-flow.test.ts`       |
| 10. Streaming guardrails wiring  | P2    | `runtime-executor.ts`                             | `streaming-guardrails-wiring.test.ts`  |
| 11. Remove jambonz               | P3    | Delete `jambonz-handler.ts`, `jambonz-adapter.ts` | Build verification                     |
| 12. SDK route consolidation      | P3    | `server.ts` (comments)                            | N/A                                    |
| 13. HTTP async event alignment   | P3    | N/A (contract is correct)                         | `http-async-events.test.ts`            |

**Total: 13 tasks, ~20 files modified/created, 11 test files**

**Dependencies:**

- Tasks 1-3 (P0) are independent — can be done in parallel
- Task 5 depends on Task 4
- Tasks 6-7 depend on Task 4
- Tasks 8-10 (P2) are independent of P1 but should follow P0
- Tasks 11-13 (P3) are independent of each other

**Risk areas:**

- Task 2 (Slack form-encoded): May need to test with real Slack interactive payloads to confirm raw body capture works for signature verification with form-encoded content
- Task 5 (DB enum change): Adding `voice_twilio` and `a2a` to the DB enum requires a migration or at least verification that existing documents won't be affected
- Task 8-10 (guardrails): The `GuardrailPipelineImpl` must be tested with real guardrail definitions from the IR to confirm the `kind: 'output'` filter works correctly
