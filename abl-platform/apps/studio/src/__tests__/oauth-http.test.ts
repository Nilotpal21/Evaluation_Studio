import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSafeFetch = vi.hoisted(() => vi.fn());

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  safeFetch: mockSafeFetch,
}));

import { httpsGet, httpsPost } from '../lib/oauth-http';

describe('oauth-http', () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
  });

  it('uses safeFetch for HTTPS GET requests', async () => {
    mockSafeFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('{"sub":"u1"}'),
    } as unknown as Response);

    const result = await httpsGet('https://oauth.example.com/userinfo', {
      Authorization: 'Bearer token',
    });

    expect(result).toEqual({ status: 200, ok: true, body: '{"sub":"u1"}' });
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://oauth.example.com/userinfo',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      }),
    );
  });

  it('uses safeFetch for HTTPS POST requests', async () => {
    mockSafeFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('{"access_token":"tok"}'),
    } as unknown as Response);

    const body = new URLSearchParams({ grant_type: 'authorization_code' }).toString();
    const result = await httpsPost('https://oauth.example.com/token', body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    expect(result.body).toContain('access_token');
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://oauth.example.com/token',
      expect.objectContaining({
        method: 'POST',
        body,
      }),
    );
  });

  it('rejects non-HTTPS OAuth URLs before network I/O', async () => {
    expect(() => httpsGet('http://metadata.google.internal/userinfo')).toThrow(
      'OAuth URL must use HTTPS',
    );
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});
