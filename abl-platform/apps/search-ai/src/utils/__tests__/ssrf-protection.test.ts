import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAndFetchURL, isURLAllowed } from '../ssrf-protection.js';
import { ValidationError } from '@agent-platform/shared-kernel';

const mockSafeFetch = vi.hoisted(() => vi.fn());
const mockAssertUrlSafeForFetch = vi.hoisted(() => vi.fn());

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  assertUrlSafeForFetch: mockAssertUrlSafeForFetch,
  safeFetch: mockSafeFetch,
}));

async function guardUrl(url: string | URL): Promise<void> {
  const value = String(url);
  if (value === 'not-a-url') throw new Error('Invalid URL format');
  if (value.startsWith('file:') || value.startsWith('ftp:')) {
    throw new Error('Blocked URL scheme');
  }
  if (value.includes('localhost') || value.includes('127.0.0.1') || value.includes('[::1]')) {
    throw new Error('Blocked localhost connection');
  }
  if (
    value.includes('10.0.0.1') ||
    value.includes('192.168.') ||
    value.includes('172.20.') ||
    value.includes('169.254.')
  ) {
    throw new Error(
      value.includes('169.254.')
        ? 'Blocked cloud metadata endpoint'
        : 'Blocked private/reserved IP address',
    );
  }
}

describe('SSRF Protection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAssertUrlSafeForFetch.mockImplementation(guardUrl);
    mockSafeFetch.mockImplementation(async (url: string | URL) => {
      await guardUrl(url);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
          }),
        },
      };
    });
  });

  describe('isURLAllowed', () => {
    it('blocks localhost IP (127.0.0.1)', async () => {
      const result = await isURLAllowed('http://127.0.0.1:8080');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('localhost');
    });

    it('blocks private IP range 10.x.x.x', async () => {
      const result = await isURLAllowed('http://10.0.0.1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('blocks private IP range 192.168.x.x', async () => {
      const result = await isURLAllowed('http://192.168.1.1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('blocks private IP range 172.16-31.x.x', async () => {
      const result = await isURLAllowed('http://172.20.0.1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('blocks cloud metadata endpoint (169.254.169.254)', async () => {
      const result = await isURLAllowed('http://169.254.169.254/latest/meta-data');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('metadata');
    });

    it('blocks link-local range (169.254.x.x)', async () => {
      const result = await isURLAllowed('http://169.254.1.1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('allows public IPs (e.g., 8.8.8.8)', async () => {
      const result = await isURLAllowed('http://8.8.8.8');
      expect(result.allowed).toBe(true);
    });

    it('allows public domains that resolve to public IPs', async () => {
      const result = await isURLAllowed('https://example.com');
      expect(result.allowed).toBe(true);
    });

    it('blocks domains that resolve to private IPs', async () => {
      mockAssertUrlSafeForFetch.mockRejectedValueOnce(
        new Error('URL resolved to a blocked private address'),
      );

      const result = await isURLAllowed('https://internal.example.com');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('private');
    });

    it('blocks non-HTTP protocols (file://)', async () => {
      const result = await isURLAllowed('file:///etc/passwd');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('scheme');
    });

    it('blocks non-HTTP protocols (ftp://)', async () => {
      const result = await isURLAllowed('ftp://example.com/file.txt');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('scheme');
    });
  });

  describe('validateAndFetchURL', () => {
    it('successfully fetches from allowed public URL', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-length', '100']]),
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('Hello World'),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
          }),
        },
      };

      mockSafeFetch.mockResolvedValue(mockResponse);

      const content = await validateAndFetchURL('https://example.com');
      expect(content).toBe('Hello World');
      expect(mockSafeFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: { 'User-Agent': 'ABL-Platform-Scraper/1.0' },
        }),
      );
    });

    it('throws ValidationError for localhost', async () => {
      await expect(validateAndFetchURL('http://localhost:8080')).rejects.toThrow(ValidationError);
      await expect(validateAndFetchURL('http://localhost:8080')).rejects.toThrow('localhost');
    });

    it('throws ValidationError for 127.0.0.1', async () => {
      await expect(validateAndFetchURL('http://127.0.0.1')).rejects.toThrow(ValidationError);
      await expect(validateAndFetchURL('http://127.0.0.1')).rejects.toThrow('localhost');
    });

    it('throws ValidationError for private IP 10.0.0.1', async () => {
      await expect(validateAndFetchURL('http://10.0.0.1')).rejects.toThrow(ValidationError);
      await expect(validateAndFetchURL('http://10.0.0.1')).rejects.toThrow('private');
    });

    it('throws ValidationError for cloud metadata endpoint', async () => {
      await expect(validateAndFetchURL('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
        ValidationError,
      );
      await expect(validateAndFetchURL('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
        'metadata',
      );
    });

    it('throws ValidationError when domain resolves to private IP', async () => {
      mockSafeFetch.mockRejectedValue(new Error('URL resolved to a blocked private address'));

      await expect(validateAndFetchURL('https://internal.company.com')).rejects.toThrow(
        ValidationError,
      );
      await expect(validateAndFetchURL('https://internal.company.com')).rejects.toThrow('private');
    });

    it('throws ValidationError for non-HTTP protocols', async () => {
      await expect(validateAndFetchURL('file:///etc/passwd')).rejects.toThrow(ValidationError);
      await expect(validateAndFetchURL('file:///etc/passwd')).rejects.toThrow('scheme');
    });

    it('throws ValidationError when response exceeds size limit', async () => {
      const largeContent = 'x'.repeat(6 * 1024 * 1024); // 6MB (exceeds 5MB limit)
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(largeContent),
              })
              .mockResolvedValueOnce({ done: true, value: undefined }),
            cancel: vi.fn(),
          }),
        },
      };

      mockSafeFetch.mockResolvedValue(mockResponse);

      await expect(validateAndFetchURL('https://example.com')).rejects.toThrow(ValidationError);
      await expect(validateAndFetchURL('https://example.com')).rejects.toThrow(
        'exceeds size limit',
      );
    });

    it('throws ValidationError when content-length header exceeds limit', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-length', String(6 * 1024 * 1024)]]), // 6MB
        body: {
          getReader: () => ({
            read: vi.fn(),
          }),
        },
      };

      mockSafeFetch.mockResolvedValue(mockResponse);

      await expect(validateAndFetchURL('https://example.com')).rejects.toThrow(ValidationError);
      await expect(validateAndFetchURL('https://example.com')).rejects.toThrow(
        'Response too large',
      );
    });

    it('throws ValidationError on HTTP error status', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Map(),
      };

      mockSafeFetch.mockResolvedValue(mockResponse);

      await expect(validateAndFetchURL('https://example.com/missing')).rejects.toThrow(
        ValidationError,
      );
      await expect(validateAndFetchURL('https://example.com/missing')).rejects.toThrow('HTTP 404');
    });

    it('throws ValidationError on invalid URL format', async () => {
      await expect(validateAndFetchURL('not-a-url')).rejects.toThrow(ValidationError);
      await expect(validateAndFetchURL('not-a-url')).rejects.toThrow('Invalid URL');
    });

    it('throws ValidationError when DNS resolution fails', async () => {
      mockSafeFetch.mockRejectedValue(new Error('DNS resolution failed for URL hostname'));

      await expect(validateAndFetchURL('https://nonexistent.invalid')).rejects.toThrow(
        ValidationError,
      );
      await expect(validateAndFetchURL('https://nonexistent.invalid')).rejects.toThrow(
        'DNS resolution failed',
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles IPv6 loopback (::1)', async () => {
      const result = await isURLAllowed('http://[::1]:8080');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('localhost');
    });

    it('allows IPv6 public addresses', async () => {
      const result = await isURLAllowed('http://[2001:4860:4860::8888]'); // Google Public DNS IPv6
      expect(result.allowed).toBe(true);
    });

    it('handles URLs with query parameters', async () => {
      const result = await isURLAllowed('https://example.com/path?key=value&foo=bar');
      expect(result.allowed).toBe(true);
    });

    it('handles URLs with fragments', async () => {
      const result = await isURLAllowed('https://example.com/page#section');
      expect(result.allowed).toBe(true);
    });

    it('blocks URLs with userinfo (potential SSRF bypass)', async () => {
      mockAssertUrlSafeForFetch.mockRejectedValueOnce(
        new Error('Blocked URL with userinfo (@) - potential SSRF bypass'),
      );

      const result = await isURLAllowed('https://user:pass@example.com');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('userinfo');
    });
  });
});
