/**
 * HTTP Fetch Adapter — fast HTTP+Cheerio path for pages that don't need
 * JavaScript rendering.
 *
 * SSRF Protection: Before every fetch, resolves the hostname via DNS and
 * rejects private/loopback IPs (unless allowPrivateIPs is explicitly set).
 *
 * Constructs a full CrawlResult from the HTTP response + cheerio parsing.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import dns from 'node:dns';
import { createLogger } from '../../logger.js';
import type { CrawlResult, CrawlResultLink } from './types.js';

const log = createLogger('http-adapter');

/** Configuration for the HTTP fetch adapter */
export interface HttpFetchConfig {
  /** Request timeout in ms (default 15000) */
  timeout: number;
  /** User-Agent header (default 'ABL-Crawler/1.0') */
  userAgent: string;
  /** Maximum redirects to follow (default 5) */
  maxRedirects: number;
  /** Maximum response body size in bytes (default 10MB) */
  maxContentLength: number;
  /** Allow fetching private/loopback IPs — disable for SSRF protection (default false) */
  allowPrivateIPs: boolean;
}

/** Result of an HTTP fetch attempt */
export interface HttpFetchResult {
  success: boolean;
  crawlResult?: CrawlResult;
  error?: string;
  statusCode?: number;
  duration: number;
}

const DEFAULT_CONFIG: HttpFetchConfig = {
  timeout: 15_000,
  userAgent: 'ABL-Crawler/1.0',
  maxRedirects: 5,
  maxContentLength: 10 * 1024 * 1024, // 10MB
  allowPrivateIPs: false,
};

/**
 * Check whether an IP address is private or loopback.
 *
 * Private ranges:
 *   IPv4: 127.x.x.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 0.0.0.0
 *   IPv4: 169.254.x.x (link-local / cloud metadata)
 *   IPv4: 100.64-127.x.x (carrier-grade NAT, RFC 6598)
 *   IPv6: ::1, fc00::/7 (fc00:: and fd00::), fe80:: (link-local)
 *   IPv6-mapped IPv4: ::ffff:10.x, ::ffff:172.16-31.x, ::ffff:192.168.x, ::ffff:127.x
 */
function isPrivateIP(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv6-mapped IPv4 (::ffff:x.x.x.x) — extract the IPv4 part and recurse
  if (lower.startsWith('::ffff:')) {
    const ipv4Part = lower.slice(7); // strip "::ffff:"
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ipv4Part)) {
      return isPrivateIP(ipv4Part);
    }
    // Even without a valid IPv4 suffix, ::ffff: prefix is suspicious
    return true;
  }

  // IPv4 checks
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip === '0.0.0.0') return true;
  if (ip.startsWith('169.254.')) return true; // Link-local / cloud metadata

  // 172.16.0.0 – 172.31.255.255
  if (ip.startsWith('172.')) {
    const parts = ip.split('.');
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  // 100.64.0.0 – 100.127.255.255 (carrier-grade NAT, RFC 6598)
  if (ip.startsWith('100.')) {
    const parts = ip.split('.');
    const second = parseInt(parts[1], 10);
    if (second >= 64 && second <= 127) return true;
  }

  // IPv6 loopback
  if (lower === '::1') return true;

  // IPv6 unique local (fc00::/7 covers fc00:: and fd00::)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;

  // IPv6 link-local
  if (lower.startsWith('fe80:')) return true;

  return false;
}

/**
 * Parse HTML with cheerio and construct a CrawlResult.
 *
 * Text extraction: strips <script>, <style>, <noscript> before getting text.
 * Link extraction: all <a href> tags resolved to absolute URLs.
 */
function parseHtmlToCrawlResult(
  url: string,
  html: string,
  statusCode: number,
  contentType: string,
  duration: number,
): CrawlResult {
  const $ = cheerio.load(html);

  // Extract title
  const title = $('title').first().text().trim();

  // Strip noise elements before text extraction
  $('script, style, noscript').remove();

  // Extract visible text
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  // Extract links — resolve relative URLs to absolute
  const links: CrawlResultLink[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    let absoluteHref: string;
    try {
      absoluteHref = new URL(href, url).toString();
    } catch {
      // Skip malformed URLs
      return;
    }

    links.push({
      text: $(el).text().trim(),
      href: absoluteHref,
      title: $(el).attr('title'),
      rel: $(el).attr('rel'),
      target: $(el).attr('target'),
    });
  });

  // Extract metadata from <meta> tags
  const metadata: Record<string, string> = {};
  $('meta[name][content]').each((_i, el) => {
    const name = $(el).attr('name');
    const content = $(el).attr('content');
    if (name && content) {
      metadata[name] = content;
    }
  });

  return {
    url,
    statusCode,
    title,
    html,
    text,
    links,
    metadata,
    crawledAt: new Date().toISOString(),
    duration,
    success: true,
    contentLength: Buffer.byteLength(html, 'utf-8'),
    contentType,
    depth: 0,
  };
}

/**
 * HTTP fetch adapter that uses axios + cheerio for fast page fetching.
 *
 * Provides SSRF protection by default — resolves DNS before fetching
 * and rejects private/loopback IPs.
 */
export class HttpAdapter {
  private readonly config: HttpFetchConfig;

  constructor(config?: Partial<HttpFetchConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Fetch a URL via HTTP and parse with cheerio into a CrawlResult.
   *
   * SSRF: When allowPrivateIPs=false (default), resolves DNS first
   * and rejects private/loopback IPs before making the request.
   */
  async fetch(url: string): Promise<HttpFetchResult> {
    const start = Date.now();

    try {
      // SSRF protection: resolve hostname and check IP, then use resolved IP
      // to prevent DNS rebinding attacks (TOCTOU between DNS check and request)
      let resolvedIp: string | null = null;
      if (!this.config.allowPrivateIPs) {
        resolvedIp = await this.checkSSRF(url);
      }

      // Build request URL — use resolved IP to prevent DNS rebinding
      let requestUrl = url;
      const headers: Record<string, string> = { 'User-Agent': this.config.userAgent };
      if (resolvedIp) {
        const parsed = new URL(url);
        headers['Host'] = parsed.host; // Preserve original Host header
        parsed.hostname = resolvedIp;
        requestUrl = parsed.toString();
      }

      const response = await axios.get<string>(requestUrl, {
        timeout: this.config.timeout,
        headers,
        maxRedirects: this.config.maxRedirects,
        maxContentLength: this.config.maxContentLength,
        responseType: 'text',
        // Accept HTML responses
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const html = typeof response.data === 'string' ? response.data : String(response.data);
      const contentType =
        typeof response.headers['content-type'] === 'string'
          ? response.headers['content-type']
          : 'text/html';
      const duration = Date.now() - start;

      if (!html || html.trim().length === 0) {
        return {
          success: false,
          error: 'Empty response body',
          statusCode: response.status,
          duration,
        };
      }

      const crawlResult = parseHtmlToCrawlResult(url, html, response.status, contentType, duration);

      log.debug('Fetched page via HTTP', {
        url,
        statusCode: response.status,
        textLength: crawlResult.text.length,
        linkCount: crawlResult.links.length,
        duration,
      });

      return {
        success: true,
        crawlResult,
        statusCode: response.status,
        duration,
      };
    } catch (error: unknown) {
      const duration = Date.now() - start;

      // SSRF rejection
      if (error instanceof SSRFError) {
        log.warn('SSRF protection blocked request', { url, error: error.message });
        return {
          success: false,
          error: error.message,
          duration,
        };
      }

      // Axios errors
      if (axios.isAxiosError(error)) {
        const errCode =
          error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 'timeout' : error.code;

        if (errCode === 'timeout') {
          log.debug('Request timed out', { url, timeout: this.config.timeout });
          return {
            success: false,
            error: `Request timeout after ${this.config.timeout}ms`,
            statusCode: error.response?.status,
            duration,
          };
        }

        // HTTP error status (4xx, 5xx)
        if (error.response) {
          log.debug('HTTP error response', {
            url,
            statusCode: error.response.status,
          });
          return {
            success: false,
            error: `HTTP ${error.response.status}`,
            statusCode: error.response.status,
            duration,
          };
        }

        return {
          success: false,
          error: error.message,
          duration,
        };
      }

      // Unknown errors
      const message = error instanceof Error ? error.message : String(error);
      log.error('Unexpected error during fetch', { url, error: message });
      return {
        success: false,
        error: message,
        duration,
      };
    }
  }

  /**
   * SSRF protection: resolve hostname via DNS and reject private/loopback IPs.
   * Returns the resolved IP address so the caller can use it for the actual
   * request, preventing DNS rebinding attacks (TOCTOU between check and fetch).
   */
  private async checkSSRF(url: string): Promise<string> {
    let hostname: string;
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
    } catch {
      throw new SSRFError(`Invalid URL: ${url}`);
    }

    // If hostname is already an IP, check directly
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
      if (isPrivateIP(hostname)) {
        throw new SSRFError(`SSRF protection: private IP address ${hostname} is not allowed`);
      }
      return hostname;
    }

    // Resolve DNS
    try {
      const { address } = await dns.promises.lookup(hostname);
      if (isPrivateIP(address)) {
        throw new SSRFError(
          `SSRF protection: hostname ${hostname} resolves to private IP ${address}`,
        );
      }
      return address;
    } catch (error: unknown) {
      if (error instanceof SSRFError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new SSRFError(`SSRF protection: DNS lookup failed for ${hostname} — ${message}`);
    }
  }
}

/** Error thrown when SSRF protection blocks a request */
class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFError';
  }
}
