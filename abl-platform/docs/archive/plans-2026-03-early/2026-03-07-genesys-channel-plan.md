# Genesys Bot Connector Channel — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Genesys Bot Connector as a synchronous webhook channel so Genesys CX can send customer messages and receive bot responses in the same HTTP request.

**Architecture:** Synchronous webhook pattern (same as VXML). Dedicated route holds HTTP connection open, executes through runtime, returns Genesys-formatted JSON. Bearer token auth via `client_secret` in encrypted connection credentials.

**Tech Stack:** TypeScript, Express, ABL runtime executor, Redis session locks, MongoDB channel connections.

---

### Task 1: Add `genesys` to ChannelType union

**Files:**

- Modify: `apps/runtime/src/channels/types.ts:40` (add before `'a2a'`)

**Step 1: Add the type**

In `apps/runtime/src/channels/types.ts`, add `'genesys'` to the `ChannelType` union. Insert it in the async/webhook channels section (after `'telegram'`, before the realtime section comment):

```typescript
  | 'telegram'
  | 'genesys'
  // Realtime channels
```

**Step 2: Verify no type errors**

Run: `cd /Users/bhanurajak/abl/_worktrees/genesys-channel && npx tsc --noEmit -p apps/runtime/tsconfig.json 2>&1 | head -20`
Expected: No new errors (existing errors may appear, but none mentioning `genesys`).

**Step 3: Commit**

```bash
git add apps/runtime/src/channels/types.ts
git commit -m "feat(channels): add genesys to ChannelType union"
```

---

### Task 2: Add genesys manifest entry

**Files:**

- Modify: `apps/runtime/src/channels/manifest.ts` (add entry after `telegram` block, around line 220)

**Step 1: Add manifest entry**

Insert after the `telegram` entry (line ~220) and before the `email` entry:

```typescript
  genesys: {
    displayName: 'Genesys',
    ingress: 'sync_webhook',
    delivery: 'sync_response',
    authMode: 'token',
    responseFormat: 'text',
    supportsRichOutput: true,
    supportsThreading: false,
    supportsMedia: false,
    supportsStreaming: false,
    isConnectionEligible: true,
    requiredCredentials: ['client_secret'],
    webhookPathPattern: '/api/v1/channels/genesys/hooks/:streamId',
    isVoice: false,
    supportsTypingIndicator: false,
  },
```

**Step 2: Verify**

Run: `cd /Users/bhanurajak/abl/_worktrees/genesys-channel && npx tsc --noEmit -p apps/runtime/tsconfig.json 2>&1 | head -20`
Expected: Clean (no new errors).

**Step 3: Commit**

```bash
git add apps/runtime/src/channels/manifest.ts
git commit -m "feat(channels): add genesys manifest entry"
```

---

### Task 3: Create the Genesys adapter

**Files:**

- Create: `apps/runtime/src/channels/adapters/genesys-adapter.ts`

**Step 1: Create the adapter file**

Reference: `apps/runtime/src/channels/adapters/vxml-adapter.ts` for the sync pattern.

```typescript
/**
 * Genesys Bot Connector Channel Adapter
 *
 * Adapter for Genesys CX Bot Connector integration. Like VXML, this is a
 * synchronous webhook channel — Genesys sends customer messages via HTTP POST
 * and expects the bot's response in the same request.
 *
 * The synchronous route (channel-genesys.ts) calls the Genesys-specific methods
 * directly; the standard sendResponse() satisfies the interface but is unused.
 */

import type { ActionSetIR } from '@abl/compiler';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelOutput,
  ChannelType,
  InboundJobPayload,
  NormalizedIncomingMessage,
  NormalizedOutgoingMessage,
  ResolvedConnection,
  SendResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Genesys Bot Connector request/response types
// ---------------------------------------------------------------------------

export interface GenesysInputMessage {
  type: 'Text' | 'Structured' | string;
  text?: string;
  buttonResponse?: {
    payload?: string;
  };
}

export interface GenesysWebhookRequest {
  genesysConversationId: string;
  inputMessage: GenesysInputMessage;
  channelSource?: string;
}

export interface GenesysReplyMessage {
  type: 'Text' | 'Structured';
  text: string;
  content?: Array<{
    contentType: 'QuickReply';
    quickReply: { text: string; payload: string };
  }>;
}

export interface GenesysResponse {
  replymessages: GenesysReplyMessage[];
  botState: 'MOREDATA' | 'COMPLETE';
  intent: string;
  endOfTask: boolean;
}

// ---------------------------------------------------------------------------
// Constants (matching koreserver config)
// ---------------------------------------------------------------------------

const TALK_TO_BOT_INTENT = 'Default Kore VA Intent';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GenesysAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'genesys';

  readonly capabilities: ChannelCapabilities = {
    supportsAsync: false,
    supportsStreaming: false,
    supportsMedia: false,
    supportsThreading: false,
  };

  // -------------------------------------------------------------------------
  // ChannelAdapter interface — mostly unused for the sync path
  // -------------------------------------------------------------------------

  async verifyRequest(): Promise<boolean> {
    // Auth is handled in the route via bearer token comparison.
    return true;
  }

  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage {
    return payload.message;
  }

  async sendResponse(
    _message: NormalizedOutgoingMessage,
    _connection: ResolvedConnection,
  ): Promise<SendResult> {
    // Genesys responses are returned synchronously from the route handler —
    // this method is never called but satisfies the adapter interface.
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Genesys-specific helpers (called directly by the sync route)
  // -------------------------------------------------------------------------

  /**
   * Build a NormalizedIncomingMessage from the raw Genesys webhook body.
   */
  buildNormalizedMessage(body: GenesysWebhookRequest): NormalizedIncomingMessage {
    const conversationId = body.genesysConversationId;
    const inputMessage = body.inputMessage;

    let text = '';
    let actionEvent: NormalizedIncomingMessage['actionEvent'];

    if (inputMessage.type === 'Structured' && inputMessage.buttonResponse?.payload) {
      text = inputMessage.buttonResponse.payload;
      actionEvent = { type: 'postback', value: inputMessage.buttonResponse.payload };
    } else {
      text = inputMessage.text || '';
    }

    return {
      externalMessageId: `${conversationId}-${Date.now()}`,
      externalSessionKey: `genesys:${conversationId}`,
      text,
      metadata: {
        genesysConversationId: conversationId,
        channelSource: body.channelSource,
      },
      timestamp: new Date(),
      actionEvent,
    };
  }

  /**
   * Build a Genesys Bot Connector response from the runtime's text output.
   */
  buildGenesysResponse(responseText: string, actions?: ActionSetIR): GenesysResponse {
    const replymessages: GenesysReplyMessage[] = [];

    // Transform ActionSetIR quick_replies into Genesys Structured messages
    if (actions?.type === 'quick_replies' && actions.options?.length) {
      replymessages.push({
        type: 'Structured',
        text: responseText,
        content: actions.options.map((opt) => ({
          contentType: 'QuickReply' as const,
          quickReply: {
            text: opt.label,
            payload: opt.value,
          },
        })),
      });
    } else {
      replymessages.push({ type: 'Text', text: responseText });
    }

    return {
      replymessages,
      botState: 'MOREDATA',
      intent: TALK_TO_BOT_INTENT,
      endOfTask: false,
    };
  }
}
```

**Step 2: Verify compilation**

Run: `cd /Users/bhanurajak/abl/_worktrees/genesys-channel && npx tsc --noEmit -p apps/runtime/tsconfig.json 2>&1 | head -20`
Expected: Clean.

**Step 3: Commit**

```bash
git add apps/runtime/src/channels/adapters/genesys-adapter.ts
git commit -m "feat(channels): add Genesys Bot Connector adapter"
```

---

### Task 4: Register GenesysAdapter in the registry

**Files:**

- Modify: `apps/runtime/src/channels/registry.ts` (add import + register call)

**Step 1: Add import and registration**

Add import after the Telegram import (line ~25):

```typescript
import { GenesysAdapter } from './adapters/genesys-adapter.js';
```

Add registration inside `getChannelRegistry()` after the Telegram registration (line ~70):

```typescript
registryInstance.register(new GenesysAdapter());
```

**Step 2: Verify**

Run: `cd /Users/bhanurajak/abl/_worktrees/genesys-channel && npx tsc --noEmit -p apps/runtime/tsconfig.json 2>&1 | head -20`
Expected: Clean.

**Step 3: Commit**

```bash
git add apps/runtime/src/channels/registry.ts
git commit -m "feat(channels): register GenesysAdapter in channel registry"
```

---

### Task 5: Create the synchronous Genesys webhook route

**Files:**

- Create: `apps/runtime/src/routes/channel-genesys.ts`

**Step 1: Create the route file**

Reference: `apps/runtime/src/routes/channel-vxml.ts` — this follows the exact same pattern.

```typescript
/**
 * Genesys Bot Connector Channel Route — Synchronous Webhook
 *
 * POST /api/v1/channels/genesys/hooks/:streamId
 *
 * Unlike async channels that queue to BullMQ and respond later, Genesys Bot
 * Connector requires an immediate JSON response — Genesys holds the HTTP
 * connection open waiting for the bot's reply.
 *
 * Flow:
 *   Genesys POST → validate payload
 *     → resolve connection (streamId = externalIdentifier)
 *     → verify bearer token
 *     → resolve/create session (genesysConversationId → runtimeSessionId)
 *     → acquire session lock
 *     → executeMessage(sessionId, text)
 *     → build Genesys response
 *     → return Content-Type: application/json
 *     → release session lock
 */

import { Router, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { acquireSessionLock, releaseSessionLock } from '../services/queues/session-lock.js';
import { GenesysAdapter } from '../channels/adapters/genesys-adapter.js';
import type { GenesysWebhookRequest } from '../channels/adapters/genesys-adapter.js';
import { extractIngressToken, tokensMatch } from '../channels/security/inbound-auth.js';

const router: RouterType = Router();
const log = createLogger('channel-genesys');
const adapter = new GenesysAdapter();

// =============================================================================
// POST /hooks/:streamId — Main Genesys webhook (synchronous)
// =============================================================================

router.post('/hooks/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const body: GenesysWebhookRequest = req.body;

  log.info('Genesys webhook received', {
    streamId,
    conversationId: body.genesysConversationId,
    messageType: body.inputMessage?.type,
  });

  // 1. Validate required fields
  if (!body.genesysConversationId) {
    log.warn('Missing genesysConversationId', { streamId });
    return res.status(400).json({ error: 'Missing genesysConversationId' });
  }

  if (!body.inputMessage?.type) {
    log.warn('Missing inputMessage.type', { streamId });
    return res.status(400).json({ error: 'Missing inputMessage.type' });
  }

  try {
    // 2. Resolve connection by streamId (externalIdentifier)
    const { resolveChannelConnection } = await import('../channels/connection-resolver.js');
    const connection = await resolveChannelConnection('genesys', streamId);

    if (!connection) {
      log.warn('No Genesys connection found', { streamId });
      return res.status(404).json({ error: 'Channel not configured' });
    }

    // 3. Verify bearer token against stored client_secret
    const expectedToken =
      (connection.credentials as Record<string, string> | null)?.client_secret ?? null;
    const providedToken = extractIngressToken(req.headers);

    if (!expectedToken) {
      if (process.env.NODE_ENV === 'production') {
        log.error('Genesys client_secret not configured in production', { streamId });
        return res.status(503).json({ error: 'Channel credentials not configured' });
      }
      log.warn('Genesys client_secret not configured; allowing in non-production', { streamId });
    } else if (!tokensMatch(providedToken, expectedToken)) {
      log.warn('Genesys bearer token verification failed', {
        streamId,
        hasToken: !!providedToken,
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 4. Build normalized message and resolve session
    const normalizedMsg = adapter.buildNormalizedMessage(body);
    const { resolveSession } = await import('../channels/session-resolver.js');
    const session = await resolveSession(connection, normalizedMsg);

    log.info('Genesys session resolved', {
      runtimeSessionId: session.runtimeSessionId,
      isNew: session.isNew,
      conversationId: body.genesysConversationId,
    });

    // 5. Acquire per-session lock (same pattern as inbound-worker and VXML)
    const lockKey = `channel:lock:${session.runtimeSessionId}`;
    const lockId = `genesys-${body.genesysConversationId}-${Date.now()}`;
    const lockAcquired = await acquireSessionLock(lockKey, lockId);

    if (!lockAcquired) {
      log.error('Session lock timeout for Genesys conversation', {
        conversationId: body.genesysConversationId,
      });
      return res.status(503).json({ error: 'Service busy, please retry' });
    }

    try {
      // 6. Execute message through runtime
      const userText = normalizedMsg.text || 'hi';
      const { getRuntimeExecutor } = await import('../services/runtime-executor.js');
      const executor = getRuntimeExecutor();

      const chunks: string[] = [];
      const execResult = await executor.executeMessage(
        session.runtimeSessionId,
        userText,
        (chunk: string) => {
          chunks.push(chunk);
        },
      );

      const responseText = execResult.response || chunks.join('');

      // 7. Build and return Genesys response
      const genesysResponse = adapter.buildGenesysResponse(responseText, execResult.actions);

      log.info('Genesys response sent', {
        conversationId: body.genesysConversationId,
        sessionId: session.runtimeSessionId,
        responseLength: responseText.length,
        messageCount: genesysResponse.replymessages.length,
      });

      return res.json(genesysResponse);
    } finally {
      await releaseSessionLock(lockKey, lockId);
    }
  } catch (error) {
    log.error('Genesys webhook processing failed', {
      streamId,
      conversationId: body.genesysConversationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
```

**Step 2: Verify compilation**

Run: `cd /Users/bhanurajak/abl/_worktrees/genesys-channel && npx tsc --noEmit -p apps/runtime/tsconfig.json 2>&1 | head -20`
Expected: Clean.

**Step 3: Commit**

```bash
git add apps/runtime/src/routes/channel-genesys.ts
git commit -m "feat(channels): add Genesys sync webhook route"
```

---

### Task 6: Mount the route and add caller context extraction

**Files:**

- Modify: `apps/runtime/src/server.ts` (add import + mount)
- Modify: `apps/runtime/src/channels/session-resolver.ts` (add genesys case)

**Step 1: Mount the route in server.ts**

Add import after the VXML import (line 62):

```typescript
import channelGenesysRouter from './routes/channel-genesys.js';
```

Add mount after the VXML mount (line 338):

```typescript
app.use('/api/v1/channels/genesys', channelGenesysRouter);
```

**Step 2: Add caller context extraction in session-resolver.ts**

In the `extractCallerContextFromChannel` function, add a `case 'genesys':` before the `default:` (around line 52):

```typescript
    case 'genesys':
      anonymousId = metadata.genesysConversationId as string;
      break;
```

**Step 3: Verify compilation**

Run: `cd /Users/bhanurajak/abl/_worktrees/genesys-channel && npx tsc --noEmit -p apps/runtime/tsconfig.json 2>&1 | head -20`
Expected: Clean.

**Step 4: Commit**

```bash
git add apps/runtime/src/server.ts apps/runtime/src/channels/session-resolver.ts
git commit -m "feat(channels): mount Genesys route and add caller context"
```

---

### Task 7: Build and verify

**Step 1: Run full build**

Run: `cd /Users/bhanurajak/abl/_worktrees/genesys-channel && pnpm build --filter=@abl/runtime`
Expected: Successful build.

**Step 2: Run tests**

Run: `cd /Users/bhanurajak/abl/_worktrees/genesys-channel && pnpm test --filter=@abl/runtime 2>&1 | tail -30`
Expected: All existing tests pass (no regressions).

**Step 3: Commit any Prettier fixes**

Run: `npx prettier --write apps/runtime/src/channels/types.ts apps/runtime/src/channels/manifest.ts apps/runtime/src/channels/registry.ts apps/runtime/src/channels/adapters/genesys-adapter.ts apps/runtime/src/routes/channel-genesys.ts apps/runtime/src/server.ts apps/runtime/src/channels/session-resolver.ts`

If changes: commit with `style: format genesys channel files`.
