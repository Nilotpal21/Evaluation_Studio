/**
 * Content Extraction Service
 *
 * Extracts text content from various document formats.
 * Each extractor handles a specific content type and returns a normalized
 * ExtractionResult with plain text, metadata, and size information.
 *
 * Built-in extractors handle text, markdown, HTML, and JSON.
 * PDF and DOCX extraction requires external packages and will throw
 * descriptive errors when attempted without the required dependencies.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ExtractionResult {
  /** Extracted plain text content */
  text: string;
  /** Detected content type */
  contentType: string;
  /** Content size in bytes */
  sizeBytes: number;
  /** Document title (if detected) */
  title?: string;
  /** Document metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// SERVICE
// =============================================================================

export class ExtractionService {
  /**
   * Extract text content from a buffer or string given its content type.
   *
   * @param content - Raw content as a Buffer or string
   * @param contentType - MIME type of the content (e.g. "text/html", "application/json")
   * @returns Extraction result with normalized plain text
   * @throws Error for unsupported or stub-only content types
   */
  async extract(content: Buffer | string, contentType: string): Promise<ExtractionResult> {
    const normalized = contentType.toLowerCase().trim();
    const raw = typeof content === 'string' ? content : content.toString('utf-8');
    const sizeBytes =
      typeof content === 'string' ? Buffer.byteLength(content, 'utf-8') : content.length;

    if (normalized === 'text/plain' || normalized === 'text/markdown') {
      return this.extractText(raw, normalized, sizeBytes);
    }

    if (normalized === 'text/html') {
      return this.extractHtml(raw, sizeBytes);
    }

    if (normalized === 'application/pdf') {
      return this.extractPdf();
    }

    if (
      normalized.startsWith('application/vnd.openxmlformats') ||
      normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return this.extractDocx();
    }

    if (normalized === 'application/json') {
      return this.extractJson(raw, sizeBytes);
    }

    throw new Error(`Unsupported content type: ${contentType}`);
  }

  // ---------------------------------------------------------------------------
  // Text / Markdown
  // ---------------------------------------------------------------------------

  /**
   * Extract from plain text or markdown. Returns content as-is and attempts
   * to detect a title from the first heading line.
   */
  private extractText(raw: string, contentType: string, sizeBytes: number): ExtractionResult {
    const title = this.detectTitleFromHeading(raw);

    return {
      text: raw,
      contentType,
      sizeBytes,
      title: title ?? undefined,
      metadata: {
        lineCount: raw.split('\n').length,
      },
    };
  }

  /**
   * Detect a title from the first markdown heading or the first non-empty line.
   * Supports `# Heading` and `=== underline` style headings.
   */
  private detectTitleFromHeading(text: string): string | null {
    const lines = text.split('\n');

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i].trim();

      // ATX heading: # Title
      const atxMatch = line.match(/^#{1,3}\s+(.+)/);
      if (atxMatch) {
        return atxMatch[1].trim();
      }

      // Setext heading: next line is === or ---
      if (line.length > 0 && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (/^[=]+$/.test(nextLine) || /^[-]+$/.test(nextLine)) {
          return line;
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  /**
   * Extract text from HTML content using regex-based tag stripping.
   * Removes `<script>` and `<style>` blocks first, then strips all remaining
   * HTML tags and normalizes whitespace.
   */
  private extractHtml(raw: string, sizeBytes: number): ExtractionResult {
    // Extract <title> content
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let title = titleMatch ? titleMatch[1].trim() : undefined;

    // Fallback to first <h1>
    if (!title) {
      const h1Match = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) {
        // Strip any nested tags from the h1 content
        title = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }
    }

    // Remove script and style blocks entirely
    let cleaned = raw.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // Remove HTML comments
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

    // Replace block-level elements with newlines for readability
    cleaned = cleaned.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, '\n');
    cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');

    // Strip all remaining HTML tags
    cleaned = cleaned.replace(/<[^>]+>/g, '');

    // Decode common HTML entities
    cleaned = this.decodeHtmlEntities(cleaned);

    // Normalize whitespace: collapse multiple spaces (but preserve newlines)
    cleaned = cleaned.replace(/[^\S\n]+/g, ' ');
    // Collapse multiple blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    // Trim each line
    cleaned = cleaned
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim();

    return {
      text: cleaned,
      contentType: 'text/html',
      sizeBytes,
      title,
      metadata: {
        originalHtmlLength: raw.length,
      },
    };
  }

  /**
   * Decode common HTML entities to their character equivalents.
   */
  private decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
      '&nbsp;': ' ',
      '&ndash;': '\u2013',
      '&mdash;': '\u2014',
      '&hellip;': '\u2026',
      '&copy;': '\u00A9',
      '&reg;': '\u00AE',
      '&trade;': '\u2122',
    };

    let result = text;
    for (const [entity, char] of Object.entries(entities)) {
      result = result.replaceAll(entity, char);
    }

    // Handle numeric entities: &#NNN; and &#xHHH;
    result = result.replace(/&#(\d+);/g, (_match, dec: string) =>
      String.fromCharCode(parseInt(dec, 10)),
    );
    result = result.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // PDF (stub)
  // ---------------------------------------------------------------------------

  /**
   * PDF extraction stub. Requires an external package.
   * @throws Error always — PDF extraction is not built in
   */
  private extractPdf(): never {
    throw new Error(
      'PDF extraction requires @agent-platform/pdf-extractor. ' +
        'Install it and register the extractor to enable PDF support.',
    );
  }

  // ---------------------------------------------------------------------------
  // DOCX (stub)
  // ---------------------------------------------------------------------------

  /**
   * DOCX extraction stub. Requires the `mammoth` package.
   * @throws Error always — DOCX extraction is not built in
   */
  private extractDocx(): never {
    throw new Error(
      'DOCX extraction requires mammoth. ' +
        'Install it (`npm install mammoth`) and register the extractor to enable DOCX support.',
    );
  }

  // ---------------------------------------------------------------------------
  // JSON
  // ---------------------------------------------------------------------------

  /**
   * Extract text representation from JSON content.
   * Parses and re-serializes with indentation for readability.
   */
  private extractJson(raw: string, sizeBytes: number): ExtractionResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // If JSON is invalid, return raw content
      return {
        text: raw,
        contentType: 'application/json',
        sizeBytes,
        metadata: {
          parseError: true,
        },
      };
    }

    const formatted = JSON.stringify(parsed, null, 2);

    // Try to detect a title from common JSON fields
    let title: string | undefined;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      title =
        typeof obj.title === 'string'
          ? obj.title
          : typeof obj.name === 'string'
            ? obj.name
            : undefined;
    }

    return {
      text: formatted,
      contentType: 'application/json',
      sizeBytes,
      title,
      metadata: {
        isArray: Array.isArray(parsed),
        keyCount:
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.keys(parsed as Record<string, unknown>).length
            : undefined,
      },
    };
  }
}
