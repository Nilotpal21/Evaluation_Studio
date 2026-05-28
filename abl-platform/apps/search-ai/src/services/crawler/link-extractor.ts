/**
 * Link Extractor — Extract and normalize links from HTML
 *
 * Parses raw HTML to extract <a href> links. Resolves relative URLs
 * against the page's base URL. Filters out non-HTTP, non-same-domain links.
 *
 * Lightweight — uses regex extraction rather than full DOM parsing.
 * Sufficient for link discovery where we don't need the full DOM tree.
 */

import { createLogger } from '@abl/compiler/platform';
import { normalizeUrl } from './pattern-matcher.js';

const logger = createLogger('link-extractor');

// ─── Types ──────────────────────────────────────────────────────────

/** Document file extensions that should be discovered but not recursed into (leaf nodes) */
// Static constant — MAX_SIZE is the literal count of extensions below (fixed, not growing)
export const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.csv',
  '.txt',
  '.rtf',
]);

export interface ExtractedLink {
  /** The normalized URL */
  url: string;
  /** Document file type if the URL points to a file (e.g. 'pdf'), null otherwise */
  fileType: string | null;
}

export interface ExtractedPage {
  /** The page URL */
  url: string;
  /** Page title from <title> tag */
  title: string;
  /** Same-domain page links (excludes file URLs — safe to recurse into) */
  links: string[];
  /** All same-domain links with metadata including file URLs tagged with fileType */
  extractedLinks: ExtractedLink[];
  /** HTTP status code */
  status: number;
  /** Content type from response headers */
  contentType: string;
}

// ─── Link Extraction ────────────────────────────────────────────────

/** Regex to extract href values from anchor tags */
const HREF_REGEX = /<a\s+[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>/gi;

/** Regex to extract <title> content */
const TITLE_REGEX = /<title[^>]*>([^<]*)<\/title>/i;

/**
 * File extensions to skip entirely (binary/archive/media/non-content).
 * Document extensions (.pdf, .docx, etc.) are intentionally NOT here —
 * they are discovered as leaf nodes with a fileType tag.
 */
// Static constant — MAX_SIZE is the literal count of extensions below (fixed, not growing)
const SKIP_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.css',
  '.js',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.exe',
  '.dmg',
  '.iso',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.xml',
  '.json',
  '.rss',
  '.atom',
]);

/** URL patterns to skip (login, cart, search, etc.) */
const SKIP_PATTERNS = [
  /\/cart/i,
  /\/checkout/i,
  /\/login/i,
  /\/signin/i,
  /\/signup/i,
  /\/register/i,
  /\/account/i,
  /\/logout/i,
  /\/search\?/i,
  /\/admin/i,
  /mailto:/i,
  /javascript:/i,
  /tel:/i,
];

/**
 * Detect document file type from a URL pathname extension.
 * Returns the extension without the dot (e.g. 'pdf') or null if not a document.
 */
export function detectFileType(pathname: string): string | null {
  const lower = pathname.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const ext = lower.substring(dotIdx);
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return ext.substring(1); // remove the leading dot
  }
  return null;
}

/**
 * Extract the page title from HTML.
 */
export function extractTitle(html: string): string {
  const match = TITLE_REGEX.exec(html);
  return match ? match[1].trim() : '';
}

/**
 * Extract all <a href> links from HTML and resolve them against the base URL.
 * Filters to same-domain, HTTP(S) links only.
 *
 * Returns both:
 * - `links`: page URLs safe to recurse into (excludes document file URLs)
 * - `extractedLinks`: all discovered links with fileType metadata
 *
 * @param html - Raw HTML content
 * @param pageUrl - The URL of the page (for resolving relative links)
 * @param domain - Only keep links matching this domain
 * @returns Object with `links` (for recursion) and `extractedLinks` (with fileType tags)
 */
export function extractLinks(
  html: string,
  pageUrl: string,
  domain: string,
): { links: string[]; extractedLinks: ExtractedLink[] } {
  const seen = new Set<string>();
  const links: string[] = [];
  const extractedLinks: ExtractedLink[] = [];

  let match: RegExpExecArray | null;
  // Reset regex state
  HREF_REGEX.lastIndex = 0;

  while ((match = HREF_REGEX.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;

    // Skip non-HTTP protocols
    if (raw.startsWith('mailto:') || raw.startsWith('javascript:') || raw.startsWith('tel:')) {
      continue;
    }

    // Resolve relative URLs
    let resolved: string;
    try {
      resolved = new URL(raw, pageUrl).href;
    } catch {
      continue;
    }

    // Must be HTTP(S)
    if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
      continue;
    }

    // Must be same domain
    let linkDomain: string;
    try {
      linkDomain = new URL(resolved).hostname;
    } catch {
      continue;
    }
    if (linkDomain !== domain) continue;

    // Get pathname for extension checks
    const pathname = new URL(resolved).pathname.toLowerCase();
    const dotIdx = pathname.lastIndexOf('.');
    const ext = dotIdx !== -1 ? pathname.substring(dotIdx) : '';

    // Skip binary/archive/media extensions entirely
    if (SKIP_EXTENSIONS.has(ext)) continue;

    // Skip known non-content patterns
    if (SKIP_PATTERNS.some((p) => p.test(resolved))) continue;

    // Normalize for dedup
    const normalized = normalizeUrl(resolved);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);

    // Detect document file type
    const fileType = detectFileType(pathname);

    // Add to extractedLinks (all discovered links including files)
    extractedLinks.push({ url: normalized, fileType });

    // Only add non-file URLs to `links` (safe to recurse into)
    if (fileType === null) {
      links.push(normalized);
    }
  }

  return { links, extractedLinks };
}

/**
 * Fetch a URL and extract its links and metadata.
 *
 * Lightweight fetch — only needs the HTML for link extraction,
 * not full content processing.
 *
 * @param url - URL to fetch
 * @param domain - Same-domain filter
 * @param timeout - Fetch timeout in ms (default 5000)
 */
export async function fetchAndExtractLinks(
  url: string,
  domain: string,
  timeout = 5000,
): Promise<ExtractedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ABL-SearchAI-Crawler/1.0 (+https://kore.ai)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') ?? '';

    // Only process HTML responses
    if (!contentType.includes('text/html') && !contentType.includes('xhtml')) {
      return {
        url,
        title: '',
        links: [],
        extractedLinks: [],
        status: response.status,
        contentType,
      };
    }

    const html = await response.text();
    const title = extractTitle(html);
    const { links, extractedLinks } = extractLinks(html, url, domain);

    return {
      url,
      title,
      links,
      extractedLinks,
      status: response.status,
      contentType,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to fetch URL', { url, error: message });
    return {
      url,
      title: '',
      links: [],
      extractedLinks: [],
      status: 0,
      contentType: '',
    };
  } finally {
    clearTimeout(timer);
  }
}
