import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosError, AxiosHeaders, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

// Mock axios before importing the module under test
vi.mock('axios', () => {
  const mockGet = vi.fn();
  return {
    default: {
      get: mockGet,
      isAxiosError: (err: unknown): err is AxiosError =>
        err != null && typeof err === 'object' && '_isAxiosError' in err,
    },
  };
});

// Mock dns.promises.lookup
vi.mock('node:dns', () => ({
  default: {
    promises: {
      lookup: vi.fn(),
    },
  },
}));

import axios from 'axios';
import dns from 'node:dns';
import { HttpAdapter } from '../../intelligence/algorithms/http-adapter.js';

const mockAxiosGet = axios.get as ReturnType<typeof vi.fn>;
const mockDnsLookup = dns.promises.lookup as ReturnType<typeof vi.fn>;

/** Helper to build a mock axios response */
function mockAxiosResponse(data: string, status = 200, contentType = 'text/html'): AxiosResponse {
  return {
    data,
    status,
    statusText: 'OK',
    headers: { 'content-type': contentType },
    config: { headers: {} as AxiosHeaders } as InternalAxiosRequestConfig,
  };
}

/** Helper to build a mock axios error */
function mockAxiosError(
  status: number | undefined,
  code?: string,
  message = 'Request failed',
): AxiosError & { _isAxiosError: true } {
  const err = new Error(message) as AxiosError & { _isAxiosError: true };
  err._isAxiosError = true;
  err.code = code;
  err.isAxiosError = true;
  err.name = 'AxiosError';
  err.toJSON = () => ({});
  if (status !== undefined) {
    err.response = {
      data: '',
      status,
      statusText: status === 404 ? 'Not Found' : 'Server Error',
      headers: {},
      config: { headers: {} as AxiosHeaders } as InternalAxiosRequestConfig,
    };
  }
  return err;
}

describe('HttpAdapter', () => {
  const adapter = new HttpAdapter();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: DNS resolves to a public IP
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  });

  // ─── Success Cases ──────────────────────────────────────────────

  describe('successful fetch', () => {
    it('returns CrawlResult with html, text, and links on 200', async () => {
      const html = `<html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Hello World</h1>
          <p>Some content here.</p>
          <a href="/about">About</a>
          <a href="https://example.com/contact">Contact</a>
        </body>
      </html>`;

      mockAxiosGet.mockResolvedValue(mockAxiosResponse(html));

      const result = await adapter.fetch('https://example.com/page');

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.crawlResult).toBeDefined();
      expect(result.crawlResult?.title).toBe('Test Page');
      expect(result.crawlResult?.text).toContain('Hello World');
      expect(result.crawlResult?.text).toContain('Some content here.');
      expect(result.crawlResult?.html).toBe(html);
      expect(result.crawlResult?.links).toHaveLength(2);
      expect(result.crawlResult?.links[0].href).toBe('https://example.com/about');
      expect(result.crawlResult?.links[0].text).toBe('About');
      expect(result.crawlResult?.links[1].href).toBe('https://example.com/contact');
      expect(result.crawlResult?.url).toBe('https://example.com/page');
      expect(result.crawlResult?.success).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── Timeout ────────────────────────────────────────────────────

  describe('timeout handling', () => {
    it('returns success=false with timeout error on ECONNABORTED', async () => {
      mockAxiosGet.mockRejectedValue(mockAxiosError(undefined, 'ECONNABORTED', 'timeout'));

      const result = await adapter.fetch('https://example.com/slow');

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('returns success=false with timeout error on ETIMEDOUT', async () => {
      mockAxiosGet.mockRejectedValue(mockAxiosError(undefined, 'ETIMEDOUT', 'timeout'));

      const result = await adapter.fetch('https://example.com/slow');

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });
  });

  // ─── HTTP Error Status Codes ────────────────────────────────────

  describe('HTTP error responses', () => {
    it('returns success=false with statusCode=404', async () => {
      mockAxiosGet.mockRejectedValue(mockAxiosError(404));

      const result = await adapter.fetch('https://example.com/missing');

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(result.error).toContain('404');
    });

    it('returns success=false with statusCode=500', async () => {
      mockAxiosGet.mockRejectedValue(mockAxiosError(500));

      const result = await adapter.fetch('https://example.com/error');

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.error).toContain('500');
    });
  });

  // ─── SSRF Protection ───────────────────────────────────────────

  describe('SSRF protection', () => {
    it('blocks 127.0.0.1 (loopback)', async () => {
      const result = await adapter.fetch('http://127.0.0.1:8080/admin');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF');
      expect(result.error).toContain('private');
      // Should NOT have called axios
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('blocks 10.0.0.1 (private class A)', async () => {
      const result = await adapter.fetch('http://10.0.0.1/internal');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF');
      expect(result.error).toContain('private');
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('blocks 192.168.1.1 (private class C)', async () => {
      const result = await adapter.fetch('http://192.168.1.1/router');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF');
      expect(result.error).toContain('private');
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('blocks 172.16.0.1 (private class B)', async () => {
      const result = await adapter.fetch('http://172.16.0.1/internal');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF');
      expect(result.error).toContain('private');
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('blocks hostname that resolves to private IP', async () => {
      mockDnsLookup.mockResolvedValue({ address: '10.0.0.5', family: 4 });

      const result = await adapter.fetch('https://internal.corp.example.com/api');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF');
      expect(result.error).toContain('private');
      expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('allows public IPs when SSRF protection is enabled', async () => {
      mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
      mockAxiosGet.mockResolvedValue(mockAxiosResponse('<html><body>OK</body></html>'));

      const result = await adapter.fetch('https://example.com');

      expect(result.success).toBe(true);
      expect(mockAxiosGet).toHaveBeenCalled();
    });

    it('allows private IPs when allowPrivateIPs=true', async () => {
      const permissive = new HttpAdapter({ allowPrivateIPs: true });
      mockAxiosGet.mockResolvedValue(mockAxiosResponse('<html><body>Internal</body></html>'));

      const result = await permissive.fetch('http://10.0.0.1/internal');

      expect(result.success).toBe(true);
      expect(mockAxiosGet).toHaveBeenCalled();
    });
  });

  // ─── Text Extraction ───────────────────────────────────────────

  describe('text extraction', () => {
    it('excludes script, style, and noscript content from text', async () => {
      const html = `<html>
        <head>
          <title>Page</title>
          <style>body { color: red; }</style>
        </head>
        <body>
          <script>var x = "should not appear";</script>
          <noscript>Enable JavaScript</noscript>
          <p>Visible content only</p>
          <style>.hidden { display: none; }</style>
        </body>
      </html>`;

      mockAxiosGet.mockResolvedValue(mockAxiosResponse(html));

      const result = await adapter.fetch('https://example.com/page');

      expect(result.success).toBe(true);
      expect(result.crawlResult?.text).toContain('Visible content only');
      expect(result.crawlResult?.text).not.toContain('should not appear');
      expect(result.crawlResult?.text).not.toContain('color: red');
      expect(result.crawlResult?.text).not.toContain('Enable JavaScript');
      expect(result.crawlResult?.text).not.toContain('display: none');
    });
  });

  // ─── Link Extraction ───────────────────────────────────────────

  describe('link extraction', () => {
    it('resolves relative URLs to absolute', async () => {
      const html = `<html><body>
        <a href="/about">About</a>
        <a href="contact.html">Contact</a>
        <a href="https://other.com/page">Other</a>
        <a href="../up">Up</a>
      </body></html>`;

      mockAxiosGet.mockResolvedValue(mockAxiosResponse(html));

      const result = await adapter.fetch('https://example.com/docs/page');

      expect(result.success).toBe(true);
      const hrefs = result.crawlResult?.links.map((l) => l.href);
      expect(hrefs).toContain('https://example.com/about');
      expect(hrefs).toContain('https://example.com/docs/contact.html');
      expect(hrefs).toContain('https://other.com/page');
      expect(hrefs).toContain('https://example.com/up');
    });

    it('extracts link attributes (title, rel, target)', async () => {
      const html = `<html><body>
        <a href="/page" title="My Page" rel="nofollow" target="_blank">Link</a>
      </body></html>`;

      mockAxiosGet.mockResolvedValue(mockAxiosResponse(html));

      const result = await adapter.fetch('https://example.com');

      const link = result.crawlResult?.links[0];
      expect(link?.title).toBe('My Page');
      expect(link?.rel).toBe('nofollow');
      expect(link?.target).toBe('_blank');
      expect(link?.text).toBe('Link');
    });

    it('skips malformed href values', async () => {
      const html = `<html><body>
        <a href="https://example.com/good">Good</a>
        <a href="://bad">Bad</a>
      </body></html>`;

      mockAxiosGet.mockResolvedValue(mockAxiosResponse(html));

      const result = await adapter.fetch('https://example.com');

      // The good link should be present; the bad one skipped
      expect(result.crawlResult?.links.length).toBeGreaterThanOrEqual(1);
      expect(result.crawlResult?.links[0].href).toBe('https://example.com/good');
    });
  });

  // ─── Empty Response ─────────────────────────────────────────────

  describe('empty response', () => {
    it('returns success=false for empty response body', async () => {
      mockAxiosGet.mockResolvedValue(mockAxiosResponse(''));

      const result = await adapter.fetch('https://example.com/empty');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Empty response');
    });

    it('returns success=false for whitespace-only response body', async () => {
      mockAxiosGet.mockResolvedValue(mockAxiosResponse('   \n\t  '));

      const result = await adapter.fetch('https://example.com/whitespace');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Empty response');
    });
  });

  // ─── Config Overrides ───────────────────────────────────────────

  describe('config overrides', () => {
    it('uses custom timeout', async () => {
      const custom = new HttpAdapter({ timeout: 5000 });
      mockAxiosGet.mockRejectedValue(mockAxiosError(undefined, 'ECONNABORTED'));

      const result = await custom.fetch('https://example.com/slow');

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
      expect(result.error).toContain('5000');
    });

    it('uses custom userAgent in request headers', async () => {
      const custom = new HttpAdapter({ userAgent: 'CustomBot/2.0' });
      mockAxiosGet.mockResolvedValue(mockAxiosResponse('<html><body>OK</body></html>'));

      await custom.fetch('https://example.com');

      // URL uses resolved IP to prevent DNS rebinding; Host header preserves original hostname
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://93.184.216.34/',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': 'CustomBot/2.0',
            Host: 'example.com',
          }),
        }),
      );
    });
  });

  // ─── Metadata Extraction ────────────────────────────────────────

  describe('metadata extraction', () => {
    it('extracts meta tags into metadata record', async () => {
      const html = `<html>
        <head>
          <title>Meta Page</title>
          <meta name="description" content="A test page">
          <meta name="author" content="Test Author">
        </head>
        <body><p>Content</p></body>
      </html>`;

      mockAxiosGet.mockResolvedValue(mockAxiosResponse(html));

      const result = await adapter.fetch('https://example.com/meta');

      expect(result.crawlResult?.metadata['description']).toBe('A test page');
      expect(result.crawlResult?.metadata['author']).toBe('Test Author');
    });
  });

  // ─── Redirect Handling ──────────────────────────────────────────

  describe('redirect handling', () => {
    it('passes maxRedirects config to axios', async () => {
      const custom = new HttpAdapter({ maxRedirects: 3 });
      mockAxiosGet.mockResolvedValue(mockAxiosResponse('<html><body>Redirected</body></html>'));

      await custom.fetch('https://example.com/redirect');

      // URL uses resolved IP to prevent DNS rebinding
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://93.184.216.34/redirect',
        expect.objectContaining({ maxRedirects: 3 }),
      );
    });
  });

  // ─── DNS Failure ────────────────────────────────────────────────

  describe('DNS failure', () => {
    it('returns SSRF error when DNS lookup fails', async () => {
      mockDnsLookup.mockRejectedValue(new Error('ENOTFOUND'));

      const result = await adapter.fetch('https://nonexistent.example.com/page');

      expect(result.success).toBe(false);
      expect(result.error).toContain('SSRF');
      expect(result.error).toContain('DNS');
    });
  });
});
