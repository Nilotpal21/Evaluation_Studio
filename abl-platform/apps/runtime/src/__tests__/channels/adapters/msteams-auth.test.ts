import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  getBotFrameworkToken,
  clearBotFrameworkTokenCache,
} from '../../../channels/adapters/msteams-auth.js';

function mockFetchSuccess(token: string, expiresIn: number) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ access_token: token, expires_in: expiresIn }),
  });
}

function mockFetchFailure(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

describe('getBotFrameworkToken', () => {
  beforeEach(() => {
    clearBotFrameworkTokenCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches a new token from Microsoft OAuth endpoint', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess('tok-123', 3600));

    const token = await getBotFrameworkToken('app-1', 'secret', 'tenant-1');

    expect(token).toBe('tok-123');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = (fetch as any).mock.calls[0];
    expect(url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(opts.method).toBe('POST');
    expect(opts.body.toString()).toContain('grant_type=client_credentials');
    expect(opts.body.toString()).toContain('client_id=app-1');
  });

  it('returns cached token on second call', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess('tok-cached', 3600));

    const first = await getBotFrameworkToken('app-1', 'secret', 'tenant-1');
    const second = await getBotFrameworkToken('app-1', 'secret', 'tenant-1');

    expect(first).toBe('tok-cached');
    expect(second).toBe('tok-cached');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses separate cache entries per tenant+app', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'tok-a', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'tok-b', expires_in: 3600 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const a = await getBotFrameworkToken('app-1', 'secret', 'tenant-1');
    const b = await getBotFrameworkToken('app-2', 'secret', 'tenant-2');

    expect(a).toBe('tok-a');
    expect(b).toBe('tok-b');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes token when expired (past expiresAt - skew)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'tok-old', expires_in: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'tok-new', expires_in: 3600 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const first = await getBotFrameworkToken('app-1', 'secret', 'tenant-1');
    expect(first).toBe('tok-old');

    // expires_in: 0 means it's already expired relative to the 60s skew
    const second = await getBotFrameworkToken('app-1', 'secret', 'tenant-1');
    expect(second).toBe('tok-new');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws on HTTP failure', async () => {
    vi.stubGlobal('fetch', mockFetchFailure(401, 'invalid_client'));

    await expect(getBotFrameworkToken('app-1', 'bad-secret', 'tenant-1')).rejects.toThrow(
      'Failed to get Bot Framework token: 401',
    );
  });

  it('throws on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(getBotFrameworkToken('app-1', 'secret', 'tenant-1')).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('clearBotFrameworkTokenCache clears all entries', async () => {
    vi.stubGlobal('fetch', mockFetchSuccess('tok-1', 3600));

    await getBotFrameworkToken('app-1', 'secret', 'tenant-1');
    expect(fetch).toHaveBeenCalledOnce();

    clearBotFrameworkTokenCache();

    // Should fetch again after cache clear
    await getBotFrameworkToken('app-1', 'secret', 'tenant-1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
