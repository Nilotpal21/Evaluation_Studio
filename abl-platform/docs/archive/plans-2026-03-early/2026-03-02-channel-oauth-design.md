# Channel OAuth Design — Generic One-Click Install

**Date:** 2026-03-02
**Branch:** `feat/channel-oauth`
**Status:** Design approved

## Problem

Channel connections (Slack, WhatsApp, etc.) require manual credential entry today. Users must create apps on provider platforms, copy tokens, and paste them into Studio. This is error-prone and inaccessible to non-developers.

Slack's OAuth V2 flow and WhatsApp's Embedded Signup both support one-click install patterns where the platform handles credential exchange automatically.

## Goals

- One-click "Add to Slack" experience for non-developers
- Generic, extensible architecture that supports any OAuth-based channel
- Adding a new channel requires only a provider adapter — no route or service changes
- Credentials flow through existing `ChannelConnection` storage (AES-256-GCM encrypted)

## Non-Goals

- Token rotation (Slack tokens are non-rotating; can add later)
- Tenant-owned Slack apps (platform-level shared app only)
- Auto-creating ChannelConnection records (Studio UI handles creation)

## Key Decisions

| Decision                         | Choice                                      | Rationale                                                  |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| App model                        | Platform-level shared app                   | One-click UX, no developer setup needed                    |
| Token type                       | Non-rotating (`xoxb-`)                      | Simpler, no refresh logic. Can enable later.               |
| Token storage                    | `ChannelConnection.encryptedCredentials`    | Existing encrypted storage for channel creds               |
| Post-callback flow               | Return to Studio UI                         | User picks deployment, names connection, saves             |
| Extensibility                    | Pluggable provider adapters                 | Each channel implements `ChannelOAuthProvider` interface   |
| Route design                     | Generic `/api/channel-oauth/:channelType/*` | Channel-agnostic routes, no per-channel endpoints          |
| Relationship to ToolOAuthService | Separate service                            | Different purpose: bot credentials vs end-user tool tokens |

## Architecture

### Why Not Extend ToolOAuthService?

`ToolOAuthService` manages **end-user tool access** — when a chat user authorizes Google Calendar, Microsoft Graph, etc. Tokens are stored per-user in `EndUserOAuthToken` keyed by `(tenantId, userId, provider)`.

Channel OAuth manages **bot installation credentials** — when an admin installs the bot into a Slack workspace. Tokens are stored per-connection in `ChannelConnection.encryptedCredentials` keyed by `(tenantId, projectId, channelType)`.

These are fundamentally different: different token owners (user vs bot), different lifecycles (user-revocable vs installation-scoped), different storage models. A separate `ChannelOAuthService` keeps both clean.

### Provider Interface

```typescript
interface ChannelOAuthProvider {
  /** Channel type identifier (matches ChannelConnection.channelType) */
  channelType: string;

  /** Build the provider-specific authorization URL */
  buildAuthorizeUrl(state: string, redirectUri: string): string;

  /** Exchange callback code for credentials + metadata */
  exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult>;
}

interface ChannelOAuthResult {
  /** Credentials to encrypt and store in ChannelConnection */
  credentials: Record<string, string>;

  /** External identifier for the connection (e.g. teamId:appId for Slack) */
  externalIdentifier: string;

  /** Suggested display name (e.g. "Slack - My Workspace") */
  displayName: string;

  /** Extra metadata for the Studio connection form */
  metadata: Record<string, unknown>;
}
```

### Service

```typescript
class ChannelOAuthService {
  private providers = new Map<string, ChannelOAuthProvider>();
  private stateStore: OAuthStateStore; // reuse Redis-backed store from ToolOAuthService

  registerProvider(provider: ChannelOAuthProvider): void;

  /** Generate state, return provider's authorize URL */
  initiateFlow(
    channelType: string,
    tenantId: string,
    userId: string,
    projectId: string,
    redirectUri: string,
  ): Promise<{ authUrl: string; state: string }>;

  /** Validate state, call provider.exchangeCode(), return result */
  handleCallback(channelType: string, code: string, state: string): Promise<ChannelOAuthResult>;
}
```

### Routes

Generic routes — no channel-specific logic:

```
POST /api/channel-oauth/:channelType/authorize
  Auth: authMiddleware (JWT required)
  Body: { redirectUri, projectId }
  Returns: { authUrl, state }

GET  /api/channel-oauth/:channelType/callback
  Auth: unifiedAuth (no JWT — provider redirect)
  Query: { code, state }
  Action: exchange code → encrypt result → redirect to Studio with payload
```

### Data Flow

```
Studio UI                    Runtime API                        Provider
─────────                    ───────────                        ────────
  │                              │                                │
  │ POST /api/channel-oauth/     │                                │
  │   :channelType/authorize     │                                │
  │─────────────────────────────>│                                │
  │                              │── lookup provider by type      │
  │                              │── provider.buildAuthorizeUrl() │
  │                              │── store state in Redis         │
  │  <── { authUrl, state } ─────│                                │
  │                              │                                │
  │── redirect user ─────────────────────────────────────────────>│
  │                              │                                │
  │                              │  <── callback ?code&state ─────│
  │                              │── validate state               │
  │                              │── provider.exchangeCode() ────>│
  │                              │  <── ChannelOAuthResult ───────│
  │                              │                                │
  │  <── redirect to Studio ─────│                                │
  │      ?payload={encrypted     │                                │
  │       credentials, extId,    │                                │
  │       displayName, metadata} │                                │
  │                              │                                │
  │ POST /api/.../channel-       │                                │
  │   connections (existing API) │                                │
  │─────────────────────────────>│                                │
  │  <── connection created ─────│                                │
```

### Slack Provider Implementation

```typescript
class SlackOAuthProvider implements ChannelOAuthProvider {
  channelType = 'slack';

  // Platform-level app credentials from env vars
  private clientId: string; // CHANNEL_OAUTH_SLACK_CLIENT_ID
  private clientSecret: string; // CHANNEL_OAUTH_SLACK_CLIENT_SECRET
  private signingSecret: string; // CHANNEL_OAUTH_SLACK_SIGNING_SECRET
  private scopes: string[];

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    // Returns: https://slack.com/oauth/v2/authorize?client_id=...&scope=...&state=...&redirect_uri=...
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult> {
    // POST https://slack.com/api/oauth.v2.access
    // Parse response: access_token, team.id, team.name, bot_user_id, app_id
    // Return:
    //   credentials: { bot_token: access_token, signing_secret: this.signingSecret }
    //   externalIdentifier: `${team.id}:${app_id}`
    //   displayName: `Slack - ${team.name}`
    //   metadata: { teamId, teamName, botUserId, appId }
  }
}
```

**Scopes requested:**

- `chat:write`, `chat:write.public` — send messages
- `im:history`, `im:write` — DMs
- `channels:read`, `channels:history` — public channels
- `groups:read`, `groups:history` — private channels
- `users:read`, `users:read.email` — user info
- `app_mentions:read` — @mentions
- `commands` — slash commands

### Studio UI

- Generic `<OAuthConnectButton channelType="slack" />` component
- Calls `POST /api/channel-oauth/slack/authorize` with `redirectUri` pointing back to Studio
- On return, decodes encrypted payload, pre-fills connection form:
  - `channelType`: from payload
  - `externalIdentifier`: from payload
  - `displayName`: from payload (editable)
  - `credentials`: from payload (hidden)
- User picks deployment, clicks Save → existing channel connection CRUD API

### Error Handling

| Error                 | Redirect to Studio with      |
| --------------------- | ---------------------------- |
| Invalid/expired state | `?error=expired`             |
| User denies access    | `?error=access_denied`       |
| Token exchange fails  | `?error=exchange_failed`     |
| Unknown channel type  | `?error=unsupported_channel` |

Studio displays user-friendly error messages for each case.

### Security

- **CSRF protection**: Random 32-byte state parameter stored in Redis with 10-min TTL
- **Token in transit**: Encrypted payload in redirect URL (signed + encrypted, not plaintext)
- **Token at rest**: AES-256-GCM tenant-scoped encryption in `ChannelConnection.encryptedCredentials`
- **Signing secret**: Comes from platform config (env var), not exposed to client or Slack OAuth response
- **Redirect URI allowlist**: Validated against `security.oauthAllowedRedirectOrigins`
- **Provider validation**: Only registered channel types accepted

### Adding a New Channel

To add OAuth for a new channel (e.g., WhatsApp):

1. Create `providers/whatsapp-oauth-provider.ts` implementing `ChannelOAuthProvider`
2. Register it in service startup: `channelOAuthService.registerProvider(new WhatsAppOAuthProvider())`
3. Add env vars: `CHANNEL_OAUTH_WHATSAPP_CLIENT_ID`, `CHANNEL_OAUTH_WHATSAPP_CLIENT_SECRET`
4. No route changes, no service changes, no Studio changes needed

### File Structure

```
apps/runtime/src/
  services/
    channel-oauth/
      channel-oauth-service.ts         # Generic service + provider registry
      channel-oauth-provider.ts        # Interface definitions
      providers/
        slack-oauth-provider.ts        # Slack implementation
        index.ts                       # Provider registration
  routes/
    channel-oauth.ts                   # Generic routes

apps/studio/src/
  components/deployments/channels/
    oauth-connect-button.tsx           # Generic OAuth connect button
```

### Testing

- **Unit**: `ChannelOAuthService` — state management, provider lookup, error cases
- **Unit**: `SlackOAuthProvider` — URL building, code exchange parsing, error handling
- **Integration**: OAuth routes — authorize → callback → redirect flow
- **E2E**: Full flow from Studio button → Slack consent → callback → connection creation

### Environment Variables

```bash
# Platform-level Slack app credentials
CHANNEL_OAUTH_SLACK_CLIENT_ID=<slack-app-client-id>
CHANNEL_OAUTH_SLACK_CLIENT_SECRET=<slack-app-client-secret>
CHANNEL_OAUTH_SLACK_SIGNING_SECRET=<slack-app-signing-secret>
CHANNEL_OAUTH_SLACK_SCOPES=chat:write,chat:write.public,im:history,im:write,channels:read,channels:history,groups:read,groups:history,users:read,users:read.email,app_mentions:read,commands
```

---

## Implementation Plan

_Merged from `2026-03-02-channel-oauth-plan.md`._

## Task 1: ChannelOAuthProvider Interface + ChannelOAuthResult Type

**Files:**

- Create: `apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts`

**Step 1: Write the interface file**

```typescript
/**
 * Channel OAuth Provider Interface
 *
 * Each channel that supports OAuth implements this interface.
 * The ChannelOAuthService delegates to providers for channel-specific logic.
 */

/** Result returned by a provider after successful OAuth code exchange */
export interface ChannelOAuthResult {
  /** Credentials to encrypt and store in ChannelConnection (e.g. { bot_token, signing_secret }) */
  credentials: Record<string, string>;

  /** External identifier for the connection (e.g. "T123ABC:A456XYZ" for Slack) */
  externalIdentifier: string;

  /** Suggested display name (e.g. "Slack - My Workspace") */
  displayName: string;

  /** Extra metadata for the Studio connection form */
  metadata: Record<string, unknown>;
}

/** Interface that each OAuth-capable channel must implement */
export interface ChannelOAuthProvider {
  /** Channel type identifier — must match ChannelConnection.channelType */
  readonly channelType: string;

  /** Build the provider-specific authorization URL */
  buildAuthorizeUrl(state: string, redirectUri: string): string;

  /** Exchange the authorization code for credentials + metadata */
  exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult>;
}
```

**Step 2: Commit**

```bash
git add apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts
git commit -m "feat(channel-oauth): add ChannelOAuthProvider interface and result type"
```

---

## Task 2: ChannelOAuthService

**Files:**

- Create: `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts`
- Create: `apps/runtime/src/services/channel-oauth/__tests__/channel-oauth-service.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelOAuthService } from '../channel-oauth-service.js';
import type { ChannelOAuthProvider, ChannelOAuthResult } from '../channel-oauth-provider.js';
import type { OAuthStateStore } from '../../tool-oauth-service.js';

function createMockProvider(channelType = 'slack'): ChannelOAuthProvider {
  return {
    channelType,
    buildAuthorizeUrl: vi.fn(
      (state, redirectUri) => `https://example.com/authorize?state=${state}`,
    ),
    exchangeCode: vi.fn(async () => ({
      credentials: { bot_token: 'xoxb-test' },
      externalIdentifier: 'T123:A456',
      displayName: 'Test Workspace',
      metadata: { teamId: 'T123' },
    })),
  };
}

function createMockStateStore(): OAuthStateStore {
  const store = new Map<string, any>();
  return {
    set: vi.fn(async (state, data) => {
      store.set(state, data);
    }),
    getAndDelete: vi.fn(async (state) => {
      const data = store.get(state);
      store.delete(state);
      return data ?? null;
    }),
  };
}

describe('ChannelOAuthService', () => {
  let service: ChannelOAuthService;
  let stateStore: OAuthStateStore;
  let provider: ChannelOAuthProvider;

  beforeEach(() => {
    stateStore = createMockStateStore();
    provider = createMockProvider();
    service = new ChannelOAuthService(stateStore);
    service.registerProvider(provider);
  });

  describe('initiateFlow', () => {
    it('returns authUrl and state for registered provider', async () => {
      const result = await service.initiateFlow(
        'slack',
        'tenant-1',
        'user-1',
        'project-1',
        'https://studio.example.com/callback',
      );

      expect(result.authUrl).toContain('https://example.com/authorize');
      expect(result.state).toBeDefined();
      expect(result.state).toHaveLength(64); // 32 bytes hex
      expect(stateStore.set).toHaveBeenCalledOnce();
    });

    it('throws for unregistered channel type', async () => {
      await expect(
        service.initiateFlow('unknown', 'tenant-1', 'user-1', 'project-1', 'https://example.com'),
      ).rejects.toThrow(/unknown/i);
    });
  });

  describe('handleCallback', () => {
    it('validates state and returns provider result', async () => {
      const { state } = await service.initiateFlow(
        'slack',
        'tenant-1',
        'user-1',
        'project-1',
        'https://studio.example.com/callback',
      );

      const result = await service.handleCallback('slack', 'auth-code-123', state);

      expect(result.credentials).toEqual({ bot_token: 'xoxb-test' });
      expect(result.externalIdentifier).toBe('T123:A456');
      expect(result.displayName).toBe('Test Workspace');
      expect(provider.exchangeCode).toHaveBeenCalledWith(
        'auth-code-123',
        'https://studio.example.com/callback',
      );
    });

    it('throws for invalid state', async () => {
      await expect(service.handleCallback('slack', 'code', 'bad-state')).rejects.toThrow(
        /invalid|expired/i,
      );
    });

    it('throws for mismatched channel type', async () => {
      const { state } = await service.initiateFlow(
        'slack',
        'tenant-1',
        'user-1',
        'project-1',
        'https://example.com',
      );

      await expect(service.handleCallback('whatsapp', 'code', state)).rejects.toThrow(/mismatch/i);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/services/channel-oauth/__tests__/channel-oauth-service.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
/**
 * Channel OAuth Service
 *
 * Generic OAuth 2.0 flow manager for channel connections.
 * Delegates channel-specific logic to ChannelOAuthProvider adapters.
 * Reuses OAuthStateStore from ToolOAuthService for CSRF state management.
 */

import crypto from 'crypto';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import { createLogger } from '@abl/compiler/platform';
import type { ChannelOAuthProvider, ChannelOAuthResult } from './channel-oauth-provider.js';
import type { OAuthStateStore } from '../tool-oauth-service.js';

const log = createLogger('channel-oauth-service');

/** Pending channel OAuth state */
export interface PendingChannelOAuthState {
  channelType: string;
  tenantId: string;
  userId: string;
  projectId: string;
  redirectUri: string;
  expiresAt: number;
}

/** State TTL: 10 minutes */
const STATE_TTL_MS = 10 * 60 * 1000;

export class ChannelOAuthService {
  private providers = new Map<string, ChannelOAuthProvider>();

  constructor(private stateStore: OAuthStateStore) {}

  /** Register a channel OAuth provider */
  registerProvider(provider: ChannelOAuthProvider): void {
    this.providers.set(provider.channelType, provider);
    log.info('Channel OAuth provider registered', { channelType: provider.channelType });
  }

  /** Get list of channel types that support OAuth */
  getRegisteredChannelTypes(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Initiate OAuth flow: generate state, return provider's authorize URL */
  async initiateFlow(
    channelType: string,
    tenantId: string,
    userId: string,
    projectId: string,
    redirectUri: string,
  ): Promise<{ authUrl: string; state: string }> {
    const provider = this.providers.get(channelType);
    if (!provider) {
      throw new AppError(
        `No OAuth provider registered for channel type: ${channelType}. Available: ${this.getRegisteredChannelTypes().join(', ') || 'none'}`,
        { ...ErrorCodes.BAD_REQUEST },
      );
    }

    const state = crypto.randomBytes(32).toString('hex');
    await this.stateStore.set(state, {
      provider: channelType, // OAuthStateStore uses 'provider' field name
      tenantId,
      userId,
      projectId,
      redirectUri,
      expiresAt: Date.now() + STATE_TTL_MS,
    } as any);

    const authUrl = provider.buildAuthorizeUrl(state, redirectUri);
    log.info('Channel OAuth flow initiated', { channelType, tenantId, projectId });
    return { authUrl, state };
  }

  /** Handle OAuth callback: validate state, exchange code, return result */
  async handleCallback(
    channelType: string,
    code: string,
    state: string,
  ): Promise<ChannelOAuthResult & { tenantId: string; userId: string; projectId: string }> {
    const pending = await this.stateStore.getAndDelete(state);
    if (!pending) {
      throw new AppError('Invalid or expired OAuth state', { ...ErrorCodes.BAD_REQUEST });
    }
    if (pending.expiresAt < Date.now()) {
      throw new AppError('OAuth state expired', { ...ErrorCodes.BAD_REQUEST });
    }
    if (pending.provider !== channelType) {
      throw new AppError(
        `Channel type mismatch: expected ${pending.provider}, got ${channelType}`,
        { ...ErrorCodes.BAD_REQUEST },
      );
    }

    const provider = this.providers.get(channelType);
    if (!provider) {
      throw new AppError(`No OAuth provider for channel type: ${channelType}`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const result = await provider.exchangeCode(code, (pending as any).redirectUri);
    log.info('Channel OAuth code exchanged', {
      channelType,
      tenantId: pending.tenantId,
      externalIdentifier: result.externalIdentifier,
    });

    return {
      ...result,
      tenantId: pending.tenantId,
      userId: pending.userId,
      projectId: (pending as any).projectId,
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && npx vitest run src/services/channel-oauth/__tests__/channel-oauth-service.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/channel-oauth/channel-oauth-service.ts \
        apps/runtime/src/services/channel-oauth/__tests__/channel-oauth-service.test.ts
git commit -m "feat(channel-oauth): add ChannelOAuthService with state management and tests"
```

---

## Task 3: SlackOAuthProvider

**Files:**

- Create: `apps/runtime/src/services/channel-oauth/providers/slack-oauth-provider.ts`
- Create: `apps/runtime/src/services/channel-oauth/providers/__tests__/slack-oauth-provider.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackOAuthProvider } from '../slack-oauth-provider.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SlackOAuthProvider', () => {
  let provider: SlackOAuthProvider;

  beforeEach(() => {
    provider = new SlackOAuthProvider({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      signingSecret: 'test-signing-secret',
      scopes: ['chat:write', 'im:history'],
    });
    mockFetch.mockReset();
  });

  it('has channelType "slack"', () => {
    expect(provider.channelType).toBe('slack');
  });

  describe('buildAuthorizeUrl', () => {
    it('builds correct Slack OAuth V2 URL', () => {
      const url = provider.buildAuthorizeUrl('state-123', 'https://example.com/callback');
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe('https://slack.com/oauth/v2/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
      expect(parsed.searchParams.get('scope')).toBe('chat:write,im:history');
      expect(parsed.searchParams.get('state')).toBe('state-123');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    });
  });

  describe('exchangeCode', () => {
    it('exchanges code and returns credentials + metadata', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          access_token: 'xoxb-test-token',
          bot_user_id: 'U123BOT',
          app_id: 'A456APP',
          team: { id: 'T789TEAM', name: 'Test Workspace' },
        }),
      });

      const result = await provider.exchangeCode('auth-code', 'https://example.com/callback');

      expect(result.credentials).toEqual({
        bot_token: 'xoxb-test-token',
        signing_secret: 'test-signing-secret',
      });
      expect(result.externalIdentifier).toBe('T789TEAM:A456APP');
      expect(result.displayName).toBe('Slack - Test Workspace');
      expect(result.metadata).toEqual({
        teamId: 'T789TEAM',
        teamName: 'Test Workspace',
        botUserId: 'U123BOT',
        appId: 'A456APP',
      });
    });

    it('throws when Slack API returns ok: false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'invalid_code' }),
      });

      await expect(
        provider.exchangeCode('bad-code', 'https://example.com/callback'),
      ).rejects.toThrow(/invalid_code/);
    });

    it('throws when HTTP request fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(provider.exchangeCode('code', 'https://example.com/callback')).rejects.toThrow(
        /500/,
      );
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/services/channel-oauth/providers/__tests__/slack-oauth-provider.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
/**
 * Slack OAuth Provider
 *
 * Implements ChannelOAuthProvider for Slack OAuth V2 flow.
 * Uses a platform-level Slack app (shared clientId/clientSecret).
 */

import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import { createLogger } from '@abl/compiler/platform';
import type { ChannelOAuthProvider, ChannelOAuthResult } from '../channel-oauth-provider.js';

const log = createLogger('slack-oauth-provider');

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  scopes: string[];
}

export class SlackOAuthProvider implements ChannelOAuthProvider {
  readonly channelType = 'slack';

  constructor(private config: SlackOAuthConfig) {}

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      scope: this.config.scopes.join(','),
      state,
      redirect_uri: redirectUri,
    });
    return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult> {
    const response = await fetch(SLACK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `Slack token exchange HTTP error: ${response.status} — ${errorText.substring(0, 200)}`,
        { ...ErrorCodes.SERVICE_UNAVAILABLE },
      );
    }

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      bot_user_id?: string;
      app_id?: string;
      team?: { id: string; name: string };
    };

    if (!data.ok || !data.access_token) {
      throw new AppError(`Slack OAuth failed: ${data.error ?? 'no access_token returned'}`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const teamId = data.team?.id ?? '';
    const teamName = data.team?.name ?? '';
    const appId = data.app_id ?? '';
    const botUserId = data.bot_user_id ?? '';

    log.info('Slack OAuth code exchanged', { teamId, appId });

    return {
      credentials: {
        bot_token: data.access_token,
        signing_secret: this.config.signingSecret,
      },
      externalIdentifier: `${teamId}:${appId}`,
      displayName: `Slack - ${teamName}`,
      metadata: { teamId, teamName, botUserId, appId },
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd apps/runtime && npx vitest run src/services/channel-oauth/providers/__tests__/slack-oauth-provider.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/channel-oauth/providers/slack-oauth-provider.ts \
        apps/runtime/src/services/channel-oauth/providers/__tests__/slack-oauth-provider.test.ts
git commit -m "feat(channel-oauth): add SlackOAuthProvider with Slack V2 flow and tests"
```

---

## Task 4: Provider Registration + Index

**Files:**

- Create: `apps/runtime/src/services/channel-oauth/providers/index.ts`
- Create: `apps/runtime/src/services/channel-oauth/index.ts`

**Step 1: Write the provider index**

`apps/runtime/src/services/channel-oauth/providers/index.ts`:

```typescript
/**
 * Channel OAuth Provider Registration
 *
 * Reads env vars and registers available channel OAuth providers.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ChannelOAuthService } from '../channel-oauth-service.js';
import { SlackOAuthProvider } from './slack-oauth-provider.js';

const log = createLogger('channel-oauth-providers');

/** Register all available channel OAuth providers from environment config */
export function registerChannelOAuthProviders(service: ChannelOAuthService): void {
  // Slack
  const slackClientId = process.env.CHANNEL_OAUTH_SLACK_CLIENT_ID;
  const slackClientSecret = process.env.CHANNEL_OAUTH_SLACK_CLIENT_SECRET;
  const slackSigningSecret = process.env.CHANNEL_OAUTH_SLACK_SIGNING_SECRET;

  if (slackClientId && slackClientSecret && slackSigningSecret) {
    const scopes = (
      process.env.CHANNEL_OAUTH_SLACK_SCOPES ??
      'chat:write,chat:write.public,im:history,im:write,channels:read,channels:history,groups:read,groups:history,users:read,users:read.email,app_mentions:read,commands'
    )
      .split(',')
      .map((s) => s.trim());

    service.registerProvider(
      new SlackOAuthProvider({
        clientId: slackClientId,
        clientSecret: slackClientSecret,
        signingSecret: slackSigningSecret,
        scopes,
      }),
    );
  } else {
    log.info('Slack channel OAuth not configured (missing CHANNEL_OAUTH_SLACK_* env vars)');
  }

  // Future providers registered here (WhatsApp, MS Teams, etc.)
}
```

`apps/runtime/src/services/channel-oauth/index.ts`:

```typescript
export { ChannelOAuthService } from './channel-oauth-service.js';
export type { ChannelOAuthProvider, ChannelOAuthResult } from './channel-oauth-provider.js';
export { registerChannelOAuthProviders } from './providers/index.js';
```

**Step 2: Commit**

```bash
git add apps/runtime/src/services/channel-oauth/providers/index.ts \
        apps/runtime/src/services/channel-oauth/index.ts
git commit -m "feat(channel-oauth): add provider registration and barrel exports"
```

---

## Task 5: Channel OAuth Routes

**Files:**

- Create: `apps/runtime/src/routes/channel-oauth.ts`

**Step 1: Write the route file**

```typescript
/**
 * Channel OAuth Routes
 *
 * Generic OAuth endpoints for channel connections.
 * POST /api/channel-oauth/:channelType/authorize — initiate OAuth flow
 * GET  /api/channel-oauth/:channelType/callback  — handle provider callback
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware, unifiedAuth } from '../middleware/auth.js';
import { requirePermission } from '@agent-platform/shared';
import { getCurrentRequestId } from '@agent-platform/shared';
import { writeAuditLog } from '../repos/auth-repo.js';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { DEFAULT_LOCAL_ORIGINS } from '@agent-platform/config';
import type { ChannelOAuthService } from '../services/channel-oauth/channel-oauth-service.js';

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/channel-oauth',
  tags: ['Channel OAuth'],
});
const log = createLogger('channel-oauth-route');

const MAX_CHANNEL_TYPE_LENGTH = 32;
const MAX_REDIRECT_URI_LENGTH = 2048;

function getAllowedRedirectOrigins(): string[] {
  const configured = getConfig().security.oauthAllowedRedirectOrigins;
  if (configured.length > 0) return configured;
  if (process.env.NODE_ENV === 'production') {
    log.warn('oauthAllowedRedirectOrigins not configured in production');
    return [];
  }
  return DEFAULT_LOCAL_ORIGINS;
}

function isValidChannelType(channelType: string): boolean {
  return /^[a-z0-9_-]+$/.test(channelType) && channelType.length <= MAX_CHANNEL_TYPE_LENGTH;
}

function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return false;
  try {
    const origin = new URL(uri).origin;
    return getAllowedRedirectOrigins().includes(origin);
  } catch {
    return false;
  }
}

function getChannelOAuthService(req: any): ChannelOAuthService | null {
  return (req.app.locals as any).channelOAuthService ?? null;
}

// ── Schemas ─────────────────────────────────────────────────────────────

const authorizeBodySchema = z.object({
  redirectUri: z.string().url().max(MAX_REDIRECT_URI_LENGTH),
  projectId: z.string().min(1),
});

const callbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
});

// ── POST /api/channel-oauth/:channelType/authorize ──────────────────────

openapi.route(
  'post',
  '/:channelType/authorize',
  {
    summary: 'Initiate channel OAuth flow',
    description:
      'Start OAuth authorization for a channel type. Returns authUrl for client-side redirect.',
    body: authorizeBodySchema,
    response: z.object({
      success: z.literal(true),
      authUrl: z.string(),
      state: z.string(),
    }),
  },
  authMiddleware,
  requirePermission('credential:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const { channelType } = req.params;
      if (!isValidChannelType(channelType)) {
        res.status(400).json({ success: false, error: 'Invalid channel type' });
        return;
      }

      const result = authorizeBodySchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ success: false, error: 'Invalid request body' });
        return;
      }

      const { redirectUri, projectId } = result.data;

      if (!isAllowedRedirectUri(redirectUri)) {
        res.status(400).json({ success: false, error: 'Redirect URI not in allowed origins' });
        return;
      }

      const service = getChannelOAuthService(req);
      if (!service) {
        res.status(503).json({ success: false, error: 'Channel OAuth service not configured' });
        return;
      }

      const { authUrl, state } = await service.initiateFlow(
        channelType,
        req.tenantContext.tenantId,
        req.tenantContext.userId,
        projectId,
        redirectUri,
      );

      log.info('Channel OAuth flow initiated', { channelType, requestId });
      writeAuditLog({
        action: 'channel-oauth:authorize',
        tenantId: req.tenantContext.tenantId,
        userId: req.tenantContext.userId,
        metadata: { channelType, projectId, requestId },
      });

      res.json({ success: true, authUrl, state });
    } catch (error: any) {
      log.error('Failed to initiate channel OAuth', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to initiate OAuth flow' });
    }
  },
);

// ── GET /api/channel-oauth/:channelType/callback ────────────────────────

openapi.route(
  'get',
  '/:channelType/callback',
  {
    summary: 'Handle channel OAuth callback',
    description:
      'Callback from OAuth provider. Exchanges code for credentials and redirects to Studio.',
    query: callbackQuerySchema,
    response: z.object({ success: z.literal(true) }),
  },
  unifiedAuth,
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { channelType } = req.params;
      if (!isValidChannelType(channelType)) {
        res.status(400).json({ success: false, error: 'Invalid channel type' });
        return;
      }

      const result = callbackQuerySchema.safeParse(req.query);
      if (!result.success) {
        res.status(400).json({ success: false, error: 'Missing code or state parameter' });
        return;
      }

      const { code, state } = result.data;

      const service = getChannelOAuthService(req);
      if (!service) {
        res.status(503).json({ success: false, error: 'Channel OAuth service not configured' });
        return;
      }

      const oauthResult = await service.handleCallback(channelType, code, state);

      log.info('Channel OAuth callback completed', { channelType, requestId });

      // Return result as JSON — the callback page (served by Studio) will
      // postMessage this to the parent window and close itself.
      res.json({
        success: true,
        channelType,
        credentials: oauthResult.credentials,
        externalIdentifier: oauthResult.externalIdentifier,
        displayName: oauthResult.displayName,
        metadata: oauthResult.metadata,
        projectId: oauthResult.projectId,
      });
    } catch (error: any) {
      log.error('Channel OAuth callback failed', { error: error?.message, requestId });
      res.status(400).json({ success: false, error: error?.message ?? 'OAuth callback failed' });
    }
  },
);

export default openapi.router;
```

**Step 2: Commit**

```bash
git add apps/runtime/src/routes/channel-oauth.ts
git commit -m "feat(channel-oauth): add generic channel OAuth routes (authorize + callback)"
```

---

## Task 6: Wire Up Service + Routes in Server Startup

**Files:**

- Modify: `apps/runtime/src/server.ts`

**Step 1: Add ChannelOAuthService initialization after ToolOAuthService block (~line 654)**

Find the end of the ToolOAuthService block (after `serverLog.info('ToolOAuthService initialized', ...)`). Add after it:

```typescript
// ─── ChannelOAuthService ──────────────────────────────────────────────
try {
  const { ChannelOAuthService, registerChannelOAuthProviders } =
    await import('./services/channel-oauth/index.js');
  const { RedisOAuthStateStore } = await import('./services/tool-oauth-service.js');

  let channelOAuthStateStore: import('./services/tool-oauth-service.js').OAuthStateStore;
  try {
    const { getRedisClient } = await import('./services/redis/redis-client.js');
    const redis = getRedisClient();
    if (redis) {
      channelOAuthStateStore = new RedisOAuthStateStore(redis as any);
    } else {
      const { InMemoryOAuthStateStore } = await import('./services/tool-oauth-service.js');
      channelOAuthStateStore = new InMemoryOAuthStateStore();
    }
  } catch {
    const { InMemoryOAuthStateStore } = await import('./services/tool-oauth-service.js');
    channelOAuthStateStore = new InMemoryOAuthStateStore();
  }

  const channelOAuthService = new ChannelOAuthService(channelOAuthStateStore);
  registerChannelOAuthProviders(channelOAuthService);
  app.locals.channelOAuthService = channelOAuthService;

  serverLog.info('ChannelOAuthService initialized', {
    registeredChannelTypes: channelOAuthService.getRegisteredChannelTypes(),
  });
} catch (error) {
  serverLog.warn('ChannelOAuthService initialization skipped', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
}
```

**Step 2: Mount the channel OAuth route (in the routes section ~line 270-307)**

Add alongside the existing `app.use('/api/oauth', oauthRouter)` line:

```typescript
const channelOAuthRouter = (await import('./routes/channel-oauth.js')).default;
app.use('/api/channel-oauth', channelOAuthRouter);
```

**Step 3: Commit**

```bash
git add apps/runtime/src/server.ts
git commit -m "feat(channel-oauth): wire ChannelOAuthService and routes into server startup"
```

---

## Task 7: Studio — OAuth Callback Page

**Files:**

- Create: `apps/studio/src/app/oauth/channel-callback/page.tsx`

This page is loaded inside the OAuth popup. After Slack redirects here, it calls the runtime callback API, then uses `postMessage` to send the result back to the parent Studio window.

**Step 1: Write the callback page**

```tsx
/**
 * Channel OAuth Callback Page
 *
 * Loaded inside the OAuth popup after the provider redirects back.
 * Extracts code+state from URL, calls runtime callback API,
 * and posts the result to the parent window via postMessage.
 */

'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';

const OAUTH_MESSAGE_TYPE = 'channel-oauth-callback';

export default function ChannelOAuthCallbackPage() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      setErrorMessage(error === 'access_denied' ? 'Authorization was denied' : error);
      setStatus('error');
      window.opener?.postMessage({ type: OAUTH_MESSAGE_TYPE, error }, window.location.origin);
      return;
    }

    if (!code || !state) {
      setErrorMessage('Missing authorization code or state');
      setStatus('error');
      window.opener?.postMessage(
        { type: OAUTH_MESSAGE_TYPE, error: 'missing_params' },
        window.location.origin,
      );
      return;
    }

    // Post code+state to parent — parent handles the API call
    window.opener?.postMessage({ type: OAUTH_MESSAGE_TYPE, code, state }, window.location.origin);
    setStatus('success');

    // Close popup after short delay
    setTimeout(() => window.close(), 1500);
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 p-8">
        {status === 'loading' && (
          <>
            <Loader2 className="w-8 h-8 text-accent mx-auto animate-spin" />
            <p className="text-sm text-muted">Processing authorization...</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle className="w-8 h-8 text-green-500 mx-auto" />
            <p className="text-sm text-foreground">
              Authorization complete. This window will close.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="w-8 h-8 text-red-500 mx-auto" />
            <p className="text-sm text-foreground">Authorization failed</p>
            {errorMessage && <p className="text-xs text-muted">{errorMessage}</p>}
            <p className="text-xs text-muted">You can close this window.</p>
          </>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/app/oauth/channel-callback/page.tsx
git commit -m "feat(studio): add channel OAuth callback page for popup flow"
```

---

## Task 8: Studio — Channel OAuth API Client

**Files:**

- Create: `apps/studio/src/api/channel-oauth.ts`

**Step 1: Write the API client**

```typescript
/**
 * Channel OAuth API Client
 *
 * Handles initiating channel OAuth flows and exchanging callback codes.
 */

import { apiFetch } from './client';

export interface ChannelOAuthAuthorizeResponse {
  success: boolean;
  authUrl: string;
  state: string;
}

export interface ChannelOAuthCallbackResult {
  success: boolean;
  channelType: string;
  credentials: Record<string, string>;
  externalIdentifier: string;
  displayName: string;
  metadata: Record<string, unknown>;
  projectId: string;
}

/** Initiate channel OAuth flow — returns the provider's authorization URL */
export async function initiateChannelOAuth(
  channelType: string,
  projectId: string,
  redirectUri: string,
): Promise<ChannelOAuthAuthorizeResponse> {
  return apiFetch(`/api/channel-oauth/${channelType}/authorize`, {
    method: 'POST',
    body: JSON.stringify({ redirectUri, projectId }),
  });
}

/** Exchange OAuth callback code for channel credentials */
export async function exchangeChannelOAuthCode(
  channelType: string,
  code: string,
  state: string,
): Promise<ChannelOAuthCallbackResult> {
  return apiFetch(
    `/api/channel-oauth/${channelType}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/api/channel-oauth.ts
git commit -m "feat(studio): add channel OAuth API client"
```

---

## Task 9: Studio — Add "Connect with OAuth" to Channel Registry + CreateInstanceDialog

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/channel-registry.tsx`
- Modify: `apps/studio/src/components/deployments/channels/CreateInstanceDialog.tsx`

**Step 1: Add `supportsOAuth` capability to channel registry**

In `channel-registry.tsx`, add to the Slack channel entry's capabilities (around line 50):

```typescript
supportsOAuth: true,
```

Also update the `ChannelCapabilities` type in `types.ts` if it exists, or add it inline.

**Step 2: Add OAuth flow to CreateInstanceDialog**

In `CreateInstanceDialog.tsx`, add the OAuth connect button and flow. The key changes:

1. Import the channel OAuth API and the existing `OAuthFlowDialog` pattern
2. When `def.capabilities.supportsOAuth` is true, show a "Connect with Slack" button instead of manual credential fields
3. On click, call `initiateChannelOAuth()` → open popup with `authUrl` → listen for `postMessage` → on success, call `exchangeChannelOAuthCode()` → pre-fill credentials + externalIdentifier + displayName → let user save

The exact modifications depend on the current component structure. Read the full `CreateInstanceDialog.tsx` before implementing to integrate cleanly.

**Key integration points:**

- Add state: `const [oauthResult, setOauthResult] = useState<ChannelOAuthCallbackResult | null>(null)`
- When `supportsOAuth`, show "Connect with Slack" button that opens popup
- On successful OAuth, set credentials from `oauthResult.credentials`, externalIdentifier from `oauthResult.externalIdentifier`, displayName from `oauthResult.displayName`
- Still allow manual credential entry as fallback (toggle between OAuth and manual)

**Step 3: Commit**

```bash
git add apps/studio/src/components/deployments/channels/channel-registry.tsx \
        apps/studio/src/components/deployments/channels/CreateInstanceDialog.tsx
git commit -m "feat(studio): add OAuth connect flow to Slack channel creation"
```

---

## Task 10: Integration Test — Full OAuth Flow

**Files:**

- Create: `apps/runtime/src/routes/__tests__/channel-oauth.test.ts`

**Step 1: Write the integration test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Test the full authorize → callback flow with mocked provider
describe('Channel OAuth Routes', () => {
  // This test verifies:
  // 1. POST /api/channel-oauth/slack/authorize returns authUrl + state
  // 2. GET /api/channel-oauth/slack/callback with valid code+state returns credentials
  // 3. Invalid state returns 400
  // 4. Unknown channel type returns appropriate error
  //
  // Implementation depends on how the test harness is set up in this project.
  // Check existing route tests (e.g. channel-connections route tests) for patterns.
  // Mirror that test setup — mock auth middleware, mock ChannelOAuthService on app.locals.
});
```

Examine existing route tests at `apps/runtime/src/routes/__tests__/` to match the testing patterns used in this project (mock setup, auth middleware mocking, etc.).

**Step 2: Run tests**

Run: `cd apps/runtime && npx vitest run src/routes/__tests__/channel-oauth.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/routes/__tests__/channel-oauth.test.ts
git commit -m "test(channel-oauth): add integration tests for OAuth routes"
```

---

## Task 11: Documentation + Final Verification

**Files:**

- Modify: `docs/CHANNEL_SYSTEM_ARCHITECTURE.md` — add Channel OAuth section
- Update: `.env.example` or relevant config docs with new env vars

**Step 1: Add Channel OAuth section to architecture doc**

Add a section describing:

- The `ChannelOAuthProvider` interface
- How to add a new provider
- Environment variables required
- OAuth flow sequence

**Step 2: Run full test suite**

Run: `cd apps/runtime && pnpm build && pnpm test`
Expected: All tests PASS, no regressions

**Step 3: Final commit**

```bash
git add docs/CHANNEL_SYSTEM_ARCHITECTURE.md
git commit -m "docs: add channel OAuth section to architecture docs"
```

---

## Summary

| Task | What                          | Files                                              |
| ---- | ----------------------------- | -------------------------------------------------- |
| 1    | Provider interface            | `channel-oauth-provider.ts`                        |
| 2    | ChannelOAuthService + tests   | `channel-oauth-service.ts` + test                  |
| 3    | SlackOAuthProvider + tests    | `slack-oauth-provider.ts` + test                   |
| 4    | Provider registration + index | `providers/index.ts`, barrel `index.ts`            |
| 5    | Generic OAuth routes          | `routes/channel-oauth.ts`                          |
| 6    | Server wiring                 | `server.ts` modifications                          |
| 7    | Studio callback page          | `oauth/channel-callback/page.tsx`                  |
| 8    | Studio API client             | `api/channel-oauth.ts`                             |
| 9    | Studio UI integration         | `channel-registry.tsx`, `CreateInstanceDialog.tsx` |
| 10   | Integration tests             | `routes/__tests__/channel-oauth.test.ts`           |
| 11   | Docs + final verification     | Architecture docs, env vars                        |
