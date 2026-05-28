# Email Graph API Transport — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Microsoft Graph API as a pluggable outbound email transport alongside existing SMTP/nodemailer.

**Architecture:** Extract `EmailSender` into a pluggable `EmailTransport` interface with two implementations — `SmtpTransport` (existing logic) and `GraphTransport` (OAuth2 client credentials + Graph sendMail). Transport selected per connection via `config.outbound.transport`.

**Tech Stack:** TypeScript, vitest, nodemailer (existing), Microsoft Graph REST API (raw fetch), OAuth2 client credentials

---

### Task 1: Create the EmailTransport Interface

**Files:**

- Create: `apps/runtime/src/services/email/transports/transport-interface.ts`

**Step 1: Create the transport interface file**

```typescript
// apps/runtime/src/services/email/transports/transport-interface.ts

/**
 * Pluggable email transport interface.
 *
 * Implementations: SmtpTransport (nodemailer), GraphTransport (Microsoft Graph API).
 * Selected per channel connection via config.outbound.transport.
 */

export interface EmailSendParams {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
}

export interface EmailTransport {
  sendReply(params: EmailSendParams): Promise<{ messageId: string }>;
  checkHealth?(): Promise<{ healthy: boolean; latencyMs: number }>;
}
```

**Step 2: Commit**

```bash
git add apps/runtime/src/services/email/transports/transport-interface.ts
git commit -m "feat(email): add EmailTransport interface for pluggable transports"
```

---

### Task 2: Extract SmtpTransport from EmailSender

**Files:**

- Create: `apps/runtime/src/services/email/transports/smtp-transport.ts`
- Modify: `apps/runtime/src/services/email/email-sender.ts`
- Test: `apps/runtime/src/__tests__/email/smtp-transport.test.ts`

**Step 1: Write the failing tests**

Create `apps/runtime/src/__tests__/email/smtp-transport.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock nodemailer before importing SmtpTransport
const mockSendMail = vi.fn();
vi.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: mockSendMail,
    verify: vi.fn().mockResolvedValue(true),
  }),
}));

import { SmtpTransport } from '../../services/email/transports/smtp-transport.js';

describe('SmtpTransport', () => {
  let transport: SmtpTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = new SmtpTransport({
      host: 'smtp.test.com',
      port: 587,
      user: 'user',
      pass: 'pass',
    });
  });

  it('sends email via nodemailer with correct fields', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<test-id@smtp.test.com>' });

    const result = await transport.sendReply({
      to: 'user@example.com',
      from: '"Agent" <agent@test.com>',
      subject: 'Re: Hello',
      text: 'Hi there',
      html: '<p>Hi there</p>',
    });

    expect(result.messageId).toBe('<test-id@smtp.test.com>');
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        from: '"Agent" <agent@test.com>',
        subject: 'Re: Hello',
        text: 'Hi there',
        html: '<p>Hi there</p>',
      }),
    );
  });

  it('includes threading headers when inReplyTo is provided', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<reply-id@smtp.test.com>' });

    await transport.sendReply({
      to: 'user@example.com',
      from: 'agent@test.com',
      subject: 'Re: Thread',
      text: 'Reply',
      inReplyTo: '<orig@example.com>',
      references: '<prev@example.com> <orig@example.com>',
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: '<orig@example.com>',
        references: '<prev@example.com> <orig@example.com>',
      }),
    );
  });

  it('includes CC and BCC recipients', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<cc-id@smtp.test.com>' });

    await transport.sendReply({
      to: 'user@example.com',
      from: 'agent@test.com',
      subject: 'Re: CC test',
      text: 'With CC',
      cc: ['cc1@example.com', 'cc2@example.com'],
      bcc: ['bcc@example.com'],
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      }),
    );
  });

  it('includes custom headers including X-ABL-Source', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<hdr-id@smtp.test.com>' });

    await transport.sendReply({
      to: 'user@example.com',
      from: 'agent@test.com',
      subject: 'Headers',
      text: 'With headers',
      headers: { 'X-Custom': 'value' },
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-ABL-Source': 'agent-platform',
          'X-Custom': 'value',
        }),
      }),
    );
  });

  it('checkHealth returns healthy when SMTP server is reachable', async () => {
    const result = await transport.checkHealth!();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/runtime && npx vitest run src/__tests__/email/smtp-transport.test.ts
```

Expected: FAIL — `SmtpTransport` does not exist yet.

**Step 3: Create SmtpTransport**

Create `apps/runtime/src/services/email/transports/smtp-transport.ts`:

```typescript
/**
 * SMTP Email Transport
 *
 * Sends emails via nodemailer. Extracted from the original EmailSender class
 * to implement the pluggable EmailTransport interface.
 */

import { createTransport, type Transporter } from 'nodemailer';
import { createLogger } from '@abl/compiler/platform';
import type { EmailTransport, EmailSendParams } from './transport-interface.js';

const log = createLogger('smtp-transport');

export interface SmtpTransportConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export class SmtpTransport implements EmailTransport {
  private transporter: Transporter;

  constructor(config: SmtpTransportConfig) {
    this.transporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
  }

  async sendReply(params: EmailSendParams): Promise<{ messageId: string }> {
    const mailOptions: Record<string, unknown> = {
      from: params.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      headers: {
        'X-ABL-Source': 'agent-platform',
        ...params.headers,
      },
    };

    if (params.html) {
      mailOptions.html = params.html;
    }
    if (params.inReplyTo) {
      mailOptions.inReplyTo = params.inReplyTo;
    }
    if (params.references) {
      mailOptions.references = params.references;
    }
    if (params.cc && params.cc.length > 0) {
      mailOptions.cc = params.cc;
    }
    if (params.bcc && params.bcc.length > 0) {
      mailOptions.bcc = params.bcc;
    }

    const result = await this.transporter.sendMail(mailOptions);

    log.info('Email sent via SMTP', {
      to: params.to,
      subject: params.subject,
      messageId: result.messageId,
    });

    return { messageId: result.messageId };
  }

  async checkHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.transporter.verify();
      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd apps/runtime && npx vitest run src/__tests__/email/smtp-transport.test.ts
```

Expected: All 5 tests PASS.

**Step 5: Refactor EmailSender to delegate to SmtpTransport**

Modify `apps/runtime/src/services/email/email-sender.ts` to become a thin wrapper that re-exports the transport for backward compat:

```typescript
/**
 * Email Sender — backward-compatible wrapper.
 *
 * Delegates to SmtpTransport. Preserved so existing imports
 * (smtp-server.ts, email-adapter.ts) continue to work without changes.
 */

import { createLogger } from '@abl/compiler/platform';
import { SmtpTransport, type SmtpTransportConfig } from './transports/smtp-transport.js';
import type { EmailSendParams } from './transports/transport-interface.js';

const log = createLogger('email-sender');

export type { EmailSendParams as SendReplyParams };

export interface EmailSenderConfig extends SmtpTransportConfig {
  fromAddress: string;
  fromName: string;
}

export class EmailSender {
  private transport: SmtpTransport;
  private fromAddress: string;
  private fromName: string;

  constructor(config: EmailSenderConfig) {
    this.fromAddress = config.fromAddress;
    this.fromName = config.fromName;
    this.transport = new SmtpTransport(config);
  }

  async sendReply(params: Omit<EmailSendParams, 'from'>): Promise<{ messageId: string }> {
    // Build subject with Re: prefix if not already present
    const subject = params.subject.match(/^Re:/i) ? params.subject : `Re: ${params.subject}`;

    return this.transport.sendReply({
      ...params,
      from: `"${this.fromName}" <${this.fromAddress}>`,
      subject,
    });
  }
}

/**
 * Create an EmailSender from environment variables.
 */
export function createEmailSenderFromEnv(): EmailSender {
  return new EmailSender({
    host: process.env.SMTP_RELAY_HOST || 'localhost',
    port: parseInt(process.env.SMTP_RELAY_PORT || '587', 10),
    user: process.env.SMTP_RELAY_USER || '',
    pass: process.env.SMTP_RELAY_PASS || '',
    fromAddress: process.env.EMAIL_FROM_ADDRESS || 'agent@localhost',
    fromName: process.env.EMAIL_FROM_NAME || 'Agent',
  });
}
```

**Step 6: Run all existing email tests to verify no regression**

```bash
cd apps/runtime && npx vitest run src/__tests__/email/
```

Expected: All existing tests PASS (smtp-server, reply-parser, feedback).

**Step 7: Commit**

```bash
git add apps/runtime/src/services/email/transports/ apps/runtime/src/services/email/email-sender.ts apps/runtime/src/__tests__/email/smtp-transport.test.ts
git commit -m "feat(email): extract SmtpTransport from EmailSender

Introduce EmailTransport interface and SmtpTransport implementation.
EmailSender becomes a thin backward-compatible wrapper delegating to
SmtpTransport. No behavior change for existing email flow."
```

---

### Task 3: Implement GraphTransport

**Files:**

- Create: `apps/runtime/src/services/email/transports/graph-transport.ts`
- Test: `apps/runtime/src/__tests__/email/graph-transport.test.ts`

**Step 1: Write the failing tests**

Create `apps/runtime/src/__tests__/email/graph-transport.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture fetch calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { GraphTransport } from '../../services/email/transports/graph-transport.js';

function makeTokenResponse(expiresIn = 3600) {
  return {
    ok: true,
    json: async () => ({
      access_token: 'test-token-123',
      expires_in: expiresIn,
      token_type: 'Bearer',
    }),
  };
}

function makeSendMailResponse(messageId = '<graph-msg-id@microsoft.com>') {
  return {
    ok: true,
    status: 202,
    headers: new Headers({ 'x-ms-request-id': messageId }),
    json: async () => ({}),
    text: async () => '',
  };
}

describe('GraphTransport', () => {
  let transport: GraphTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    transport = new GraphTransport({
      tenantId: 'test-tenant',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      senderAddress: 'agent@company.com',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires token via client credentials and sends email', async () => {
    mockFetch
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeSendMailResponse());

    const result = await transport.sendReply({
      to: 'user@example.com',
      from: 'agent@company.com',
      subject: 'Re: Hello',
      text: 'Hi there',
      html: '<p>Hi there</p>',
    });

    expect(result.messageId).toBeDefined();

    // Verify token request
    const tokenCall = mockFetch.mock.calls[0];
    expect(tokenCall[0]).toBe('https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token');
    const tokenBody = tokenCall[1].body as URLSearchParams;
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('client_id')).toBe('test-client');
    expect(tokenBody.get('client_secret')).toBe('test-secret');
    expect(tokenBody.get('scope')).toBe('https://graph.microsoft.com/.default');

    // Verify sendMail request
    const sendCall = mockFetch.mock.calls[1];
    expect(sendCall[0]).toBe('https://graph.microsoft.com/v1.0/users/agent@company.com/sendMail');
    expect(sendCall[1].headers['Authorization']).toBe('Bearer test-token-123');
    const sendBody = JSON.parse(sendCall[1].body);
    expect(sendBody.message.subject).toBe('Re: Hello');
    expect(sendBody.message.body.contentType).toBe('HTML');
    expect(sendBody.message.toRecipients[0].emailAddress.address).toBe('user@example.com');
  });

  it('caches token and reuses on second send', async () => {
    mockFetch
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeSendMailResponse())
      .mockResolvedValueOnce(makeSendMailResponse());

    await transport.sendReply({
      to: 'a@example.com',
      from: 'agent@company.com',
      subject: 'First',
      text: 'first',
    });
    await transport.sendReply({
      to: 'b@example.com',
      from: 'agent@company.com',
      subject: 'Second',
      text: 'second',
    });

    // Token fetched once, sendMail called twice = 3 total fetches
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('refreshes token when expired', async () => {
    // First token expires in 60s
    mockFetch
      .mockResolvedValueOnce(makeTokenResponse(60))
      .mockResolvedValueOnce(makeSendMailResponse());

    await transport.sendReply({
      to: 'a@example.com',
      from: 'agent@company.com',
      subject: 'First',
      text: 'first',
    });

    // Advance past expiry (60s - 300s buffer means already expired, so next call refreshes)
    vi.advanceTimersByTime(61_000);

    mockFetch
      .mockResolvedValueOnce(makeTokenResponse(3600))
      .mockResolvedValueOnce(makeSendMailResponse());

    await transport.sendReply({
      to: 'b@example.com',
      from: 'agent@company.com',
      subject: 'Second',
      text: 'second',
    });

    // Two token requests + two sendMail = 4
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('retries once on 401 with fresh token', async () => {
    mockFetch
      // First token
      .mockResolvedValueOnce(makeTokenResponse())
      // First sendMail → 401
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
      // Refresh token
      .mockResolvedValueOnce(makeTokenResponse())
      // Retry sendMail → success
      .mockResolvedValueOnce(makeSendMailResponse());

    const result = await transport.sendReply({
      to: 'user@example.com',
      from: 'agent@company.com',
      subject: 'Retry test',
      text: 'should retry',
    });

    expect(result.messageId).toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('throws on 429 with retryAfterMs', async () => {
    mockFetch.mockResolvedValueOnce(makeTokenResponse()).mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '30' }),
      text: async () => 'Too Many Requests',
    });

    await expect(
      transport.sendReply({
        to: 'user@example.com',
        from: 'agent@company.com',
        subject: 'Rate limit',
        text: 'rate limited',
      }),
    ).rejects.toThrow(/rate limit/i);
  });

  it('includes CC and BCC in Graph payload', async () => {
    mockFetch
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeSendMailResponse());

    await transport.sendReply({
      to: 'user@example.com',
      from: 'agent@company.com',
      subject: 'CC test',
      text: 'with cc',
      cc: ['cc1@example.com', 'cc2@example.com'],
      bcc: ['bcc@example.com'],
    });

    const sendBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(sendBody.message.ccRecipients).toEqual([
      { emailAddress: { address: 'cc1@example.com' } },
      { emailAddress: { address: 'cc2@example.com' } },
    ]);
    expect(sendBody.message.bccRecipients).toEqual([
      { emailAddress: { address: 'bcc@example.com' } },
    ]);
  });

  it('includes threading headers in internetMessageHeaders', async () => {
    mockFetch
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeSendMailResponse());

    await transport.sendReply({
      to: 'user@example.com',
      from: 'agent@company.com',
      subject: 'Thread test',
      text: 'threaded',
      inReplyTo: '<orig@example.com>',
      references: '<prev@example.com> <orig@example.com>',
      headers: { 'X-ABL-Source': 'agent-platform' },
    });

    const sendBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const imHeaders = sendBody.message.internetMessageHeaders;
    expect(imHeaders).toContainEqual({ name: 'In-Reply-To', value: '<orig@example.com>' });
    expect(imHeaders).toContainEqual({
      name: 'References',
      value: '<prev@example.com> <orig@example.com>',
    });
    expect(imHeaders).toContainEqual({ name: 'X-ABL-Source', value: 'agent-platform' });
  });

  it('sends plain text when html is not provided', async () => {
    mockFetch
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce(makeSendMailResponse());

    await transport.sendReply({
      to: 'user@example.com',
      from: 'agent@company.com',
      subject: 'Plain text',
      text: 'no html',
    });

    const sendBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(sendBody.message.body.contentType).toBe('Text');
    expect(sendBody.message.body.content).toBe('no html');
  });

  it('checkHealth validates mailbox exists', async () => {
    mockFetch
      .mockResolvedValueOnce(makeTokenResponse())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ mail: 'agent@company.com' }) });

    const result = await transport.checkHealth!();
    expect(result.healthy).toBe(true);

    const healthCall = mockFetch.mock.calls[1];
    expect(healthCall[0]).toBe('https://graph.microsoft.com/v1.0/users/agent@company.com');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/runtime && npx vitest run src/__tests__/email/graph-transport.test.ts
```

Expected: FAIL — `GraphTransport` does not exist yet.

**Step 3: Implement GraphTransport**

Create `apps/runtime/src/services/email/transports/graph-transport.ts`:

```typescript
/**
 * Microsoft Graph API Email Transport
 *
 * Sends emails via the Graph API using OAuth2 client credentials.
 * Token is cached in-memory with a 5-minute safety buffer before expiry.
 */

import { createLogger } from '@abl/compiler/platform';
import type { EmailTransport, EmailSendParams } from './transport-interface.js';

const log = createLogger('graph-transport');

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphTransportConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderAddress: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class GraphTransport implements EmailTransport {
  private config: GraphTransportConfig;
  private cachedToken: CachedToken | null = null;

  constructor(config: GraphTransportConfig) {
    this.config = config;
  }

  async sendReply(params: EmailSendParams): Promise<{ messageId: string }> {
    const token = await this.getAccessToken();
    const body = this.buildSendMailPayload(params);

    const url = `${GRAPH_API_BASE}/users/${encodeURIComponent(this.config.senderAddress)}/sendMail`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // 401 — token may be stale, retry once with fresh token
    if (response.status === 401) {
      log.warn('Graph API returned 401, refreshing token and retrying');
      this.cachedToken = null;
      const freshToken = await this.getAccessToken();
      const retryResponse = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${freshToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!retryResponse.ok) {
        const errText = await retryResponse.text();
        throw new Error(
          `Graph API sendMail failed after token refresh: ${retryResponse.status} ${errText}`,
        );
      }

      const messageId = retryResponse.headers.get('x-ms-request-id') || `graph-${Date.now()}`;
      log.info('Email sent via Graph API (after retry)', { to: params.to, messageId });
      return { messageId };
    }

    // 429 — rate limited
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
      const err = new Error(`Graph API rate limit exceeded. Retry after ${retryMs}ms`);
      (err as any).retryAfterMs = retryMs;
      throw err;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Graph API sendMail failed: ${response.status} ${errText}`);
    }

    const messageId = response.headers.get('x-ms-request-id') || `graph-${Date.now()}`;
    log.info('Email sent via Graph API', { to: params.to, messageId });
    return { messageId };
  }

  async checkHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const token = await this.getAccessToken();
      const url = `${GRAPH_API_BASE}/users/${encodeURIComponent(this.config.senderAddress)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return {
        healthy: response.ok,
        latencyMs: Date.now() - start,
      };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.accessToken;
    }

    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    });

    const response = await fetch(url, {
      method: 'POST',
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to acquire Graph API token: ${response.status} ${errText}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS,
    };

    log.info('Graph API token acquired', { expiresIn: data.expires_in });
    return data.access_token;
  }

  private buildSendMailPayload(params: EmailSendParams) {
    const internetMessageHeaders: Array<{ name: string; value: string }> = [];

    if (params.inReplyTo) {
      internetMessageHeaders.push({ name: 'In-Reply-To', value: params.inReplyTo });
    }
    if (params.references) {
      internetMessageHeaders.push({ name: 'References', value: params.references });
    }
    if (params.headers) {
      for (const [name, value] of Object.entries(params.headers)) {
        internetMessageHeaders.push({ name, value });
      }
    }

    const message: Record<string, unknown> = {
      subject: params.subject,
      body: params.html
        ? { contentType: 'HTML', content: params.html }
        : { contentType: 'Text', content: params.text },
      toRecipients: [{ emailAddress: { address: params.to } }],
    };

    if (params.cc && params.cc.length > 0) {
      message.ccRecipients = params.cc.map((addr) => ({
        emailAddress: { address: addr },
      }));
    }

    if (params.bcc && params.bcc.length > 0) {
      message.bccRecipients = params.bcc.map((addr) => ({
        emailAddress: { address: addr },
      }));
    }

    if (internetMessageHeaders.length > 0) {
      message.internetMessageHeaders = internetMessageHeaders;
    }

    return { message, saveToSentItems: true };
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd apps/runtime && npx vitest run src/__tests__/email/graph-transport.test.ts
```

Expected: All 9 tests PASS.

**Step 5: Commit**

```bash
git add apps/runtime/src/services/email/transports/graph-transport.ts apps/runtime/src/__tests__/email/graph-transport.test.ts
git commit -m "feat(email): add GraphTransport for Microsoft Graph API sendMail

OAuth2 client credentials flow with in-memory token caching.
Supports HTML/text body, CC/BCC, RFC 5322 threading via
internetMessageHeaders, 401 retry, and 429 rate limit handling."
```

---

### Task 4: Integrate Transport Selection into EmailAdapter

**Files:**

- Modify: `apps/runtime/src/channels/adapters/email-adapter.ts`
- Test: `apps/runtime/src/__tests__/email/email-adapter-transport.test.ts`

**Step 1: Write the failing tests**

Create `apps/runtime/src/__tests__/email/email-adapter-transport.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the transports
const mockSmtpSendReply = vi.fn();
const mockGraphSendReply = vi.fn();

vi.mock('../../services/email/transports/smtp-transport.js', () => ({
  SmtpTransport: class {
    sendReply = mockSmtpSendReply;
  },
}));

vi.mock('../../services/email/transports/graph-transport.js', () => ({
  GraphTransport: class {
    sendReply = mockGraphSendReply;
  },
}));

// Mock feedback token
vi.mock('../../services/email/feedback-token.js', () => ({
  signFeedbackToken: () => 'mock-token',
}));

import { EmailAdapter } from '../../channels/adapters/email-adapter.js';
import type { NormalizedOutgoingMessage, ResolvedConnection } from '../../channels/types.js';

function makeConnection(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 'conn-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    channelType: 'email',
    externalIdentifier: 'agent@company.com',
    credentials: null,
    config: {},
    status: 'active',
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<NormalizedOutgoingMessage> = {},
): NormalizedOutgoingMessage {
  return {
    sessionId: 'session-1',
    text: 'Hello from agent',
    eventType: 'agent.response',
    metadata: {
      from: 'user@example.com',
      subject: 'Test',
      messageId: '<orig@example.com>',
      references: '<prev@example.com>',
    },
    ...overrides,
  };
}

describe('EmailAdapter transport selection', () => {
  let adapter: EmailAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new EmailAdapter();
  });

  it('uses SMTP transport by default (no outbound config)', async () => {
    mockSmtpSendReply.mockResolvedValue({ messageId: '<smtp-id>' });
    const connection = makeConnection();

    const result = await adapter.sendResponse(makeMessage(), connection);

    expect(result.success).toBe(true);
    expect(mockSmtpSendReply).toHaveBeenCalled();
    expect(mockGraphSendReply).not.toHaveBeenCalled();
  });

  it('uses Graph transport when config.outbound.transport is graph', async () => {
    mockGraphSendReply.mockResolvedValue({ messageId: '<graph-id>' });

    const connection = makeConnection({
      config: {
        outbound: {
          transport: 'graph',
          graph: {
            tenantId: 'azure-tenant',
            clientId: 'app-id',
            senderAddress: 'agent@company.com',
          },
        },
      },
      credentials: { graph_client_secret: 'secret-123' },
    });

    const result = await adapter.sendResponse(makeMessage(), connection);

    expect(result.success).toBe(true);
    expect(mockGraphSendReply).toHaveBeenCalled();
    expect(mockSmtpSendReply).not.toHaveBeenCalled();
  });

  it('uses SMTP transport when config.outbound.transport is smtp', async () => {
    mockSmtpSendReply.mockResolvedValue({ messageId: '<smtp-id>' });

    const connection = makeConnection({
      config: { outbound: { transport: 'smtp' } },
    });

    const result = await adapter.sendResponse(makeMessage(), connection);

    expect(result.success).toBe(true);
    expect(mockSmtpSendReply).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd apps/runtime && npx vitest run src/__tests__/email/email-adapter-transport.test.ts
```

Expected: FAIL — adapter still uses `createEmailSenderFromEnv()` directly.

**Step 3: Update EmailAdapter to use pluggable transports**

Modify `apps/runtime/src/channels/adapters/email-adapter.ts`:

Replace the import at line 11:

```typescript
// REMOVE:
// import { createEmailSenderFromEnv } from '../../services/email/email-sender.js';

// ADD:
import { resolveEmailTransport } from '../../services/email/transports/resolve-transport.js';
```

Replace lines 180-193 (inside the `try` block of `sendResponse`):

```typescript
const htmlBody = wrapHtml(
  emailHeader + (await safeMarked.parse(message.text)) + csatBlock + emailFooter,
);

const transport = resolveEmailTransport(_connection);
const fromAddress = _connection.externalIdentifier || 'agent@localhost';
const fromName = (_connection.config?.fromName as string) || 'Agent';
const subject = (metadata.subject as string) || '(no subject)';
const replySubject = subject.match(/^Re:/i) ? subject : `Re: ${subject}`;
const refChain = [metadata.references, metadata.messageId].filter(Boolean).join(' ');

const result = await transport.sendReply({
  to: metadata.from as string,
  from: `"${fromName}" <${fromAddress}>`,
  subject: replySubject,
  text: message.text,
  html: htmlBody,
  inReplyTo: metadata.messageId as string | undefined,
  references: refChain || undefined,
  ...(cc.length > 0 && { cc }),
  headers: { 'X-ABL-Source': 'agent-platform' },
});
```

**Step 4: Create the transport resolver**

Create `apps/runtime/src/services/email/transports/resolve-transport.ts`:

```typescript
/**
 * Resolve which EmailTransport to use for a given channel connection.
 *
 * Caches transport instances per connection ID to reuse Graph API token cache.
 */

import { createLogger } from '@abl/compiler/platform';
import { SmtpTransport } from './smtp-transport.js';
import { GraphTransport } from './graph-transport.js';
import type { EmailTransport } from './transport-interface.js';
import type { ResolvedConnection } from '../../../channels/types.js';

const log = createLogger('email-transport-resolver');

const MAX_CACHE_SIZE = 100;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  transport: EmailTransport;
  createdAt: number;
}

const transportCache = new Map<string, CacheEntry>();

function evictStale(): void {
  const now = Date.now();
  for (const [key, entry] of transportCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      transportCache.delete(key);
    }
  }
}

function getCached(key: string, factory: () => EmailTransport): EmailTransport {
  const existing = transportCache.get(key);
  if (existing && Date.now() - existing.createdAt < CACHE_TTL_MS) {
    return existing.transport;
  }

  // Evict stale entries if at capacity
  if (transportCache.size >= MAX_CACHE_SIZE) {
    evictStale();
    // If still at capacity after eviction, delete oldest
    if (transportCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = transportCache.keys().next().value!;
      transportCache.delete(oldestKey);
    }
  }

  const transport = factory();
  transportCache.set(key, { transport, createdAt: Date.now() });
  return transport;
}

export function resolveEmailTransport(connection: ResolvedConnection): EmailTransport {
  const outbound = connection.config?.outbound as
    | { transport?: string; graph?: Record<string, string> }
    | undefined;

  const transportType = outbound?.transport ?? 'smtp';

  if (transportType === 'graph') {
    const graphConfig = outbound?.graph;
    if (!graphConfig?.tenantId || !graphConfig?.clientId || !graphConfig?.senderAddress) {
      throw new Error('Graph transport requires tenantId, clientId, and senderAddress in config');
    }

    const clientSecret = (connection.credentials as Record<string, unknown> | null)
      ?.graph_client_secret as string | undefined;
    if (!clientSecret) {
      throw new Error('Graph transport requires graph_client_secret in credentials');
    }

    return getCached(`graph:${connection.id}`, () => {
      log.info('Creating Graph transport', { connectionId: connection.id });
      return new GraphTransport({
        tenantId: graphConfig.tenantId,
        clientId: graphConfig.clientId,
        clientSecret,
        senderAddress: graphConfig.senderAddress,
      });
    });
  }

  return getCached('smtp-default', () => {
    log.info('Creating SMTP transport from env');
    return new SmtpTransport({
      host: process.env.SMTP_RELAY_HOST || 'localhost',
      port: parseInt(process.env.SMTP_RELAY_PORT || '587', 10),
      user: process.env.SMTP_RELAY_USER || '',
      pass: process.env.SMTP_RELAY_PASS || '',
    });
  });
}

/** Clear the transport cache (for testing). */
export function clearTransportCache(): void {
  transportCache.clear();
}
```

**Step 5: Run all email tests**

```bash
cd apps/runtime && npx vitest run src/__tests__/email/
```

Expected: All tests PASS (smtp-transport, graph-transport, adapter-transport, smtp-server, reply-parser, feedback).

**Step 6: Commit**

```bash
git add apps/runtime/src/channels/adapters/email-adapter.ts apps/runtime/src/services/email/transports/resolve-transport.ts apps/runtime/src/__tests__/email/email-adapter-transport.test.ts
git commit -m "feat(email): integrate pluggable transport into EmailAdapter

EmailAdapter.sendResponse() now delegates to resolveEmailTransport()
which selects SmtpTransport or GraphTransport based on
connection.config.outbound.transport. Transport instances are cached
per connection with TTL eviction. Defaults to SMTP for backward compat."
```

---

### Task 5: Final Verification & Cleanup

**Step 1: Run the full runtime test suite**

```bash
cd apps/runtime && npx vitest run
```

Expected: All tests pass. No regressions.

**Step 2: Build check**

```bash
pnpm build --filter=@abl/runtime
```

Expected: Clean build with no type errors.

**Step 3: Run prettier on all changed files**

```bash
npx prettier --write \
  apps/runtime/src/services/email/transports/transport-interface.ts \
  apps/runtime/src/services/email/transports/smtp-transport.ts \
  apps/runtime/src/services/email/transports/graph-transport.ts \
  apps/runtime/src/services/email/transports/resolve-transport.ts \
  apps/runtime/src/services/email/email-sender.ts \
  apps/runtime/src/channels/adapters/email-adapter.ts \
  apps/runtime/src/__tests__/email/smtp-transport.test.ts \
  apps/runtime/src/__tests__/email/graph-transport.test.ts \
  apps/runtime/src/__tests__/email/email-adapter-transport.test.ts
```

**Step 4: Final commit if prettier changed anything**

```bash
git add -A && git diff --cached --quiet || git commit -m "style: format email transport files"
```

---

## File Summary

| Action | File                                               | Purpose                                   |
| ------ | -------------------------------------------------- | ----------------------------------------- |
| Create | `services/email/transports/transport-interface.ts` | `EmailTransport` + `EmailSendParams`      |
| Create | `services/email/transports/smtp-transport.ts`      | SMTP impl (extracted from EmailSender)    |
| Create | `services/email/transports/graph-transport.ts`     | Graph API impl (OAuth2 + sendMail)        |
| Create | `services/email/transports/resolve-transport.ts`   | Per-connection transport resolver + cache |
| Modify | `services/email/email-sender.ts`                   | Thin wrapper delegating to SmtpTransport  |
| Modify | `channels/adapters/email-adapter.ts`               | Use resolveEmailTransport()               |
| Create | `__tests__/email/smtp-transport.test.ts`           | 5 tests                                   |
| Create | `__tests__/email/graph-transport.test.ts`          | 9 tests                                   |
| Create | `__tests__/email/email-adapter-transport.test.ts`  | 3 tests                                   |

All paths relative to `apps/runtime/src/`.
