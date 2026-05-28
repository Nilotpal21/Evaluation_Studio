/**
 * Readability Service
 *
 * Uses Mozilla Readability to extract main content from web pages.
 * Removes navigation, ads, footers, and other noise while preserving
 * article content, images, tables, and semantic structure.
 *
 * Design:
 * - Input: Raw HTML string from crawler
 * - Output: Cleaned HTML (article content only) + metadata
 * - Preserves HTML format for Docling extraction pipeline
 * - JSDOM provides DOM API for Readability algorithm
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

// =============================================================================
// TYPES
// =============================================================================

export interface ReadabilityResult {
  /** Cleaned HTML (article content only) */
  cleanedHTML: string;
  /** Metadata extracted by Readability */
  metadata: ReadabilityMetadata;
  /** Whether cleaning was successful */
  success: boolean;
  /** Error message if cleaning failed */
  error?: string;
}

export interface ReadabilityMetadata {
  /** Article title */
  title: string;
  /** Article author (if detected) */
  author?: string;
  /** Article excerpt/description */
  excerpt?: string;
  /** Content length (characters) */
  contentLength: number;
  /** Text content length (characters) */
  textContentLength: number;
  /** Whether noise was removed (true if Readability extracted content) */
  cleaned: boolean;
  /** Size reduction percentage (0-100) */
  sizeReduction: number;
  /** Original HTML size (bytes) */
  originalSize: number;
  /** Cleaned HTML size (bytes) */
  cleanedSize: number;
  /** Whether content was preserved via fallback (Readability stripped too much) */
  readabilityFallback?: boolean;
}

// =============================================================================
// SERVICE
// =============================================================================

export class ReadabilityService {
  /**
   * Clean HTML content using Mozilla Readability
   *
   * @param rawHTML - Raw HTML from crawler
   * @param url - Original URL (used for relative link resolution)
   * @param siteType - Site type from profiler ('static', 'spa', 'hybrid', 'unknown')
   * @returns Cleaned HTML and metadata
   */
  cleanHTML(
    rawHTML: string,
    url: string,
    siteType?: 'static' | 'spa' | 'hybrid' | 'unknown',
  ): ReadabilityResult {
    try {
      // Validate input
      if (!rawHTML || rawHTML.trim().length === 0) {
        return {
          cleanedHTML: rawHTML,
          metadata: this.createEmptyMetadata(rawHTML),
          success: false,
          error: 'Empty HTML content',
        };
      }

      const originalSize = Buffer.byteLength(rawHTML, 'utf-8');

      // Detect if this is a documentation site (skip Readability for docs sites)
      const isDocsSite = this.isDocumentationSite(url, siteType);

      if (isDocsSite) {
        // For documentation sites, skip Readability - just clean scripts/styles
        const cleanedHTML = this.minimalClean(rawHTML);
        const cleanedSize = Buffer.byteLength(cleanedHTML, 'utf-8');
        const sizeReduction = Math.round(((originalSize - cleanedSize) / originalSize) * 100);

        return {
          cleanedHTML,
          metadata: {
            title: this.extractTitleFromHTML(rawHTML),
            contentLength: cleanedHTML.length,
            textContentLength: this.extractTextLength(cleanedHTML),
            cleaned: false, // We didn't run Readability, just minimal cleaning
            sizeReduction: Math.max(0, sizeReduction),
            originalSize,
            cleanedSize,
          },
          success: true,
        };
      }

      // Parse HTML with JSDOM
      const dom = new JSDOM(rawHTML, { url });
      const document = dom.window.document;

      // Apply Readability
      const reader = new Readability(document, {
        keepClasses: true,
        charThreshold: 25,
        nbTopCandidates: 10,
      });

      const article = reader.parse();

      // If Readability failed to extract content, return original HTML
      if (!article || !article.content) {
        return {
          cleanedHTML: rawHTML,
          metadata: {
            title: article?.title || this.extractTitleFromHTML(rawHTML),
            author: article?.byline,
            excerpt: article?.excerpt,
            contentLength: rawHTML.length,
            textContentLength: this.extractTextLength(rawHTML),
            cleaned: false,
            sizeReduction: 0,
            originalSize,
            cleanedSize: originalSize,
          },
          success: false,
          error: 'Readability could not extract article content',
        };
      }

      // Check preservation ratio — if Readability stripped too much, fall back to minimal cleaning
      const rawTextLength = this.extractTextLength(rawHTML);
      const preservationRatio =
        article.textContent && rawTextLength > 0 ? article.textContent.length / rawTextLength : 0;

      if (preservationRatio < 0.3) {
        const cleanedHTML = this.minimalClean(rawHTML);
        const cleanedSize = Buffer.byteLength(cleanedHTML, 'utf-8');
        const sizeReduction = Math.round(((originalSize - cleanedSize) / originalSize) * 100);

        return {
          cleanedHTML,
          metadata: {
            title: article.title || this.extractTitleFromHTML(rawHTML),
            contentLength: cleanedHTML.length,
            textContentLength: this.extractTextLength(cleanedHTML),
            cleaned: false,
            sizeReduction: Math.max(0, sizeReduction),
            originalSize,
            cleanedSize,
            readabilityFallback: true,
          },
          success: true,
        };
      }

      // Wrap cleaned content in basic HTML structure for Docling
      const cleanedHTML = this.wrapInHTMLStructure(article.content, article.title);
      const cleanedSize = Buffer.byteLength(cleanedHTML, 'utf-8');
      const sizeReduction = Math.round(((originalSize - cleanedSize) / originalSize) * 100);

      return {
        cleanedHTML,
        metadata: {
          title: article.title || 'Untitled',
          author: article.byline || undefined,
          excerpt: article.excerpt || undefined,
          contentLength: article.content.length,
          textContentLength: article.textContent?.length || 0,
          cleaned: true,
          sizeReduction: Math.max(0, sizeReduction), // Ensure non-negative
          originalSize,
          cleanedSize,
        },
        success: true,
      };
    } catch (error) {
      // On error, return original HTML (graceful degradation)
      const originalSize = Buffer.byteLength(rawHTML, 'utf-8');
      return {
        cleanedHTML: rawHTML,
        metadata: {
          title: this.extractTitleFromHTML(rawHTML),
          contentLength: rawHTML.length,
          textContentLength: this.extractTextLength(rawHTML),
          cleaned: false,
          sizeReduction: 0,
          originalSize,
          cleanedSize: originalSize,
        },
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Detect if URL is a documentation site
   * Documentation sites have navigation-heavy structures that Readability treats as noise
   */
  private isDocumentationSite(
    url: string,
    _siteType?: 'static' | 'spa' | 'hybrid' | 'unknown',
  ): boolean {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();
      const pathname = parsedUrl.pathname.toLowerCase();

      const docPatterns = [
        /^docs?\./i,
        /^documentation\./i,
        /^developer\./i,
        /^api\./i,
        /^reference\./i,
        /^guide\./i,
        /^learn\./i,
        /^help\./i,
        /^support\./i,
        /^knowledge\./i,
        /^manual\./i,
        /^wiki\./i,
        /^kb\./i,
        /^faq\./i,
        /^community\./i,
        /^forum\./i,
        /^blog\./i,
        /^resources\./i,
      ];

      if (docPatterns.some((pattern) => pattern.test(hostname))) {
        return true;
      }

      const pathDocPatterns = [
        /\/docs?\//i,
        /\/documentation\//i,
        /\/api\//i,
        /\/reference\//i,
        /\/guide\//i,
        /\/manual\//i,
        /\/wiki\//i,
        /\/kb\//i,
        /\/faq\//i,
        /\/help\//i,
        /\/support\//i,
        /\/knowledge/i,
        /\/tutorials?\//i,
        /\/how-to\//i,
        /\/articles?\//i,
        /\/blog\//i,
        /\/resources\//i,
      ];

      return pathDocPatterns.some((pattern) => pattern.test(pathname));
    } catch {
      return false;
    }
  }

  /**
   * Minimal HTML cleaning: remove scripts, styles, comments
   * Preserves all content structure - for documentation sites
   */
  private minimalClean(rawHTML: string): string {
    // Remove script tags and content
    let cleaned = rawHTML.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // Remove style tags and content
    cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    // Remove HTML comments
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

    // Remove inline event handlers (onclick, onload, etc.)
    cleaned = cleaned.replace(/\s+on\w+="[^"]*"/gi, '');
    cleaned = cleaned.replace(/\s+on\w+='[^']*'/gi, '');

    return cleaned;
  }

  /**
   * Wrap cleaned content in minimal HTML structure
   * Preserves semantic HTML for Docling extraction
   */
  private wrapInHTMLStructure(content: string, title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${this.escapeHTML(title)}</title>
</head>
<body>
  <article>
    ${content}
  </article>
</body>
</html>`;
  }

  /**
   * Extract title from raw HTML using simple regex (fallback)
   */
  private extractTitleFromHTML(html: string): string {
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : 'Untitled';
  }

  /**
   * Extract text length from HTML (rough estimate)
   */
  private extractTextLength(html: string): number {
    // Remove script and style tags
    const withoutScripts = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    const withoutStyles = withoutScripts.replace(
      /<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi,
      '',
    );
    // Remove all HTML tags
    const text = withoutStyles.replace(/<[^>]+>/g, '');
    // Trim and count
    return text.trim().length;
  }

  /**
   * Create empty metadata for failed extraction
   */
  private createEmptyMetadata(rawHTML: string): ReadabilityMetadata {
    const size = Buffer.byteLength(rawHTML, 'utf-8');
    return {
      title: 'Untitled',
      contentLength: rawHTML.length,
      textContentLength: 0,
      cleaned: false,
      sizeReduction: 0,
      originalSize: size,
      cleanedSize: size,
    };
  }

  /**
   * Escape HTML special characters
   */
  private escapeHTML(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Singleton instance
export const readabilityService = new ReadabilityService();
