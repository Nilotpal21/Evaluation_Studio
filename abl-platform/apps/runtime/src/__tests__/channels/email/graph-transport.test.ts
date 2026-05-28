import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GraphTransportConfig } from '../../../services/email/transports/graph-transport.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: GraphTransportConfig = {
  tenantId: 'test-tenant-id',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  senderAddress: 'bot@example.com',
};

function tokenResponse(expiresIn = 3600) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: `token-${Date.now()}`, expires_in: expiresIn }),
    text: async () => '',
    headers: new Headers(),
  } as unknown as Response;
}

function draftCreatedOk(internetMessageId = '<draft-abc@example.com>') {
  return {
    ok: true,
    status: 201,
    json: async () => ({ id: 'AAMkDraft123', internetMessageId }),
    text: async () => '',
    headers: new Headers(),
  } as unknown as Response;
}

function sendDraftOk() {
  return {
    ok: true,
    status: 202,
    text: async () => '',
    headers: new Headers(),
  } as unknown as Response;
}

describe('GraphTransport', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function createTransport() {
    const { GraphTransport } =
      await import('../../../services/email/transports/graph-transport.js');
    return new GraphTransport(DEFAULT_CONFIG);
  }

  it('acquires token via client credentials and sends email via draft-then-send', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(draftCreatedOk('<msg-abc@example.com>'))
      .mockResolvedValueOnce(sendDraftOk());

    const transport = await createTransport();
    const result = await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'Hello',
      text: 'Body text',
    });

    // Returns RFC 5322 internetMessageId from the draft
    expect(result.messageId).toBe('<msg-abc@example.com>');

    // Verify token request
    const tokenCall = mockFetch.mock.calls[0];
    expect(tokenCall[0]).toContain('login.microsoftonline.com');
    expect(tokenCall[0]).toContain('test-tenant-id');
    const tokenBody = tokenCall[1].body as URLSearchParams;
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('client_id')).toBe('test-client-id');
    expect(tokenBody.get('client_secret')).toBe('test-client-secret');
    expect(tokenBody.get('scope')).toBe('https://graph.microsoft.com/.default');

    // Verify draft creation request
    const draftCall = mockFetch.mock.calls[1];
    expect(draftCall[0]).toContain('/users/bot%40example.com/messages');
    expect(draftCall[0]).not.toContain('/send');
    const draftBody = JSON.parse(draftCall[1].body);
    expect(draftBody.subject).toBe('Hello');
    expect(draftBody.toRecipients).toEqual([{ emailAddress: { address: 'user@test.com' } }]);

    // Verify send request
    const sendCall = mockFetch.mock.calls[2];
    expect(sendCall[0]).toContain('/messages/AAMkDraft123/send');
  });

  it('caches token and reuses on second send', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse()) // 1st: token
      .mockResolvedValueOnce(draftCreatedOk('<msg-1@example.com>')) // 2nd: draft #1
      .mockResolvedValueOnce(sendDraftOk()) // 3rd: send #1
      .mockResolvedValueOnce(draftCreatedOk('<msg-2@example.com>')) // 4th: draft #2
      .mockResolvedValueOnce(sendDraftOk()); // 5th: send #2

    const transport = await createTransport();
    await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'First',
      text: 'Body 1',
    });
    await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'Second',
      text: 'Body 2',
    });

    // 5 total: 1 token + 2 draft-send pairs (token cached for second send)
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(mockFetch.mock.calls[0][0]).toContain('login.microsoftonline.com');
    expect(mockFetch.mock.calls[1][0]).toContain('/messages');
    expect(mockFetch.mock.calls[2][0]).toContain('/send');
    expect(mockFetch.mock.calls[3][0]).toContain('/messages');
    expect(mockFetch.mock.calls[4][0]).toContain('/send');
  });

  it('refreshes token when expired', async () => {
    vi.useFakeTimers();

    mockFetch
      .mockResolvedValueOnce(tokenResponse(3600)) // initial token (1hr)
      .mockResolvedValueOnce(draftCreatedOk()) // first draft
      .mockResolvedValueOnce(sendDraftOk()) // first send
      .mockResolvedValueOnce(tokenResponse(3600)) // refreshed token
      .mockResolvedValueOnce(draftCreatedOk()) // second draft
      .mockResolvedValueOnce(sendDraftOk()); // second send

    const transport = await createTransport();
    await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'Before expiry',
      text: 'Body',
    });

    // Advance time past expiry (3600s - 300s buffer = 3300s effective)
    vi.advanceTimersByTime(3400 * 1000);

    await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'After expiry',
      text: 'Body',
    });

    // 6 calls: token + draft + send + token (refreshed) + draft + send
    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(mockFetch.mock.calls[0][0]).toContain('login.microsoftonline.com');
    expect(mockFetch.mock.calls[3][0]).toContain('login.microsoftonline.com');
  });

  it('retries once on 401 with fresh token', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse()) // initial token
      .mockResolvedValueOnce({
        // draft creation returns 401
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
        headers: new Headers(),
      } as unknown as Response)
      .mockResolvedValueOnce(tokenResponse()) // fresh token
      .mockResolvedValueOnce(draftCreatedOk('<msg-retry@example.com>')) // retry draft succeeds
      .mockResolvedValueOnce(sendDraftOk()); // send draft

    const transport = await createTransport();
    const result = await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'Retry test',
      text: 'Body',
    });

    expect(result.messageId).toBe('<msg-retry@example.com>');
    // 5 calls: token + 401 draft + fresh token + retry draft + send
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('throws on 429 with retryAfterMs', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
      headers: new Headers({ 'Retry-After': '120' }),
    } as unknown as Response);

    const transport = await createTransport();
    try {
      await transport.sendReply({
        from: 'bot@example.com',
        to: 'user@test.com',
        subject: 'Rate limited',
        text: 'Body',
      });
      expect.unreachable('Expected sendReply to throw');
    } catch (err: unknown) {
      expect((err as Error).message).toMatch(/rate limit/i);
      expect((err as Record<string, unknown>).retryAfterMs).toBe(120_000);
    }
  });

  it('includes CC and BCC in Graph payload', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(draftCreatedOk())
      .mockResolvedValueOnce(sendDraftOk());

    const transport = await createTransport();
    await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'CC Test',
      text: 'Body',
      cc: ['cc1@test.com', 'cc2@test.com'],
      bcc: ['bcc@test.com'],
    });

    // Draft creation call (index 1) contains the message payload
    const draftBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(draftBody.ccRecipients).toEqual([
      { emailAddress: { address: 'cc1@test.com' } },
      { emailAddress: { address: 'cc2@test.com' } },
    ]);
    expect(draftBody.bccRecipients).toEqual([{ emailAddress: { address: 'bcc@test.com' } }]);
  });

  it('includes threading headers in internetMessageHeaders', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(draftCreatedOk())
      .mockResolvedValueOnce(sendDraftOk());

    const transport = await createTransport();
    await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'Thread Test',
      text: 'Body',
      inReplyTo: '<orig-msg@test.com>',
      references: '<prev-msg@test.com>',
      headers: { 'X-Custom': 'custom-value' },
    });

    const draftBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(draftBody.internetMessageHeaders).toEqual(
      expect.arrayContaining([
        { name: 'In-Reply-To', value: '<orig-msg@test.com>' },
        { name: 'References', value: '<prev-msg@test.com>' },
        { name: 'X-Custom', value: 'custom-value' },
      ]),
    );
  });

  it('sends plain text when html is not provided', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(draftCreatedOk())
      .mockResolvedValueOnce(sendDraftOk());

    const transport = await createTransport();
    await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'Plain text',
      text: 'Just text, no HTML.',
    });

    const draftBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(draftBody.body).toEqual({
      contentType: 'Text',
      content: 'Just text, no HTML.',
    });
  });

  it('sends HTML when html is provided', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(draftCreatedOk())
      .mockResolvedValueOnce(sendDraftOk());

    const transport = await createTransport();
    await transport.sendReply({
      from: 'bot@example.com',
      to: 'user@test.com',
      subject: 'HTML email',
      text: 'Fallback text',
      html: '<p>Rich content</p>',
    });

    const draftBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(draftBody.body).toEqual({
      contentType: 'HTML',
      content: '<p>Rich content</p>',
    });
  });

  it('checkHealth validates mailbox exists', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
    } as unknown as Response);

    const transport = await createTransport();
    const health = await transport.checkHealth();

    expect(health.healthy).toBe(true);
    expect(typeof health.latencyMs).toBe('number');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify it called GET /users/{senderAddress}
    const healthCall = mockFetch.mock.calls[1];
    expect(healthCall[0]).toContain('/users/bot%40example.com');
    expect(healthCall[1].method).toBeUndefined(); // GET is default, no method set
  });
});
