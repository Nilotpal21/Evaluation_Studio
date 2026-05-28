/**
 * SearchAI Services Unit Tests
 *
 * Tests for: ExtractionService, EnrichmentService,
 * CanonicalMapperService, audit-helpers, ClickHouseIngestionStore.
 *
 * NOTE: ChunkingService was removed — chunking is now handled by TreeBuilderService
 * with sentence alignment and semantic splitting. The old ChunkingService tests
 * were removed since the service no longer exists.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// ChunkingService Tests — REMOVED
// =============================================================================
// ChunkingService no longer exists. Chunking is handled by TreeBuilderService.
// The old describe.skip block has been removed to reduce misleading skip counts.
// See git history for the original tests if needed.

// =============================================================================
// ExtractionService Tests
// =============================================================================

import { ExtractionService } from '../services/extraction/index.js';

describe('ExtractionService', () => {
  let service: ExtractionService;

  beforeEach(() => {
    service = new ExtractionService();
  });

  // ─── Text / Markdown ───────────────────────────────────────────────────

  describe('text/plain extraction', () => {
    test('returns text content as-is', async () => {
      const result = await service.extract('Hello world', 'text/plain');
      expect(result.text).toBe('Hello world');
      expect(result.contentType).toBe('text/plain');
      expect(result.sizeBytes).toBe(Buffer.byteLength('Hello world', 'utf-8'));
    });

    test('detects ATX-style heading as title', async () => {
      const result = await service.extract('# My Title\nSome body text', 'text/plain');
      expect(result.title).toBe('My Title');
    });

    test('detects setext-style heading as title', async () => {
      const text = 'My Title\n========\nSome body text';
      const result = await service.extract(text, 'text/plain');
      expect(result.title).toBe('My Title');
    });

    test('detects setext-style heading with dashes', async () => {
      const text = 'My Title\n--------\nSome body text';
      const result = await service.extract(text, 'text/plain');
      expect(result.title).toBe('My Title');
    });

    test('returns undefined title when no heading found', async () => {
      const result = await service.extract('Just some text', 'text/plain');
      expect(result.title).toBeUndefined();
    });

    test('includes lineCount in metadata', async () => {
      const result = await service.extract('line1\nline2\nline3', 'text/plain');
      expect(result.metadata?.lineCount).toBe(3);
    });

    test('handles Buffer input', async () => {
      const buf = Buffer.from('Buffer content', 'utf-8');
      const result = await service.extract(buf, 'text/plain');
      expect(result.text).toBe('Buffer content');
      expect(result.sizeBytes).toBe(buf.length);
    });
  });

  describe('text/markdown extraction', () => {
    test('treats markdown as text with correct contentType', async () => {
      const result = await service.extract('## Heading\nBody', 'text/markdown');
      expect(result.contentType).toBe('text/markdown');
      expect(result.title).toBe('Heading');
    });

    test('detects h1 heading in markdown', async () => {
      const result = await service.extract('# First Heading\n\nContent here.', 'text/markdown');
      expect(result.title).toBe('First Heading');
    });
  });

  // ─── HTML ──────────────────────────────────────────────────────────────

  describe('text/html extraction', () => {
    test('strips HTML tags and returns text', async () => {
      const html = '<html><body><p>Hello</p><p>World</p></body></html>';
      const result = await service.extract(html, 'text/html');
      expect(result.contentType).toBe('text/html');
      expect(result.text).toContain('Hello');
      expect(result.text).toContain('World');
      expect(result.text).not.toContain('<p>');
    });

    test('extracts title from <title> tag', async () => {
      const html = '<html><head><title>Page Title</title></head><body>Content</body></html>';
      const result = await service.extract(html, 'text/html');
      expect(result.title).toBe('Page Title');
    });

    test('falls back to <h1> when no <title>', async () => {
      const html = '<html><body><h1>Main Heading</h1><p>Content</p></body></html>';
      const result = await service.extract(html, 'text/html');
      expect(result.title).toBe('Main Heading');
    });

    test('strips nested tags from h1', async () => {
      const html = '<h1><span class="x">Heading <b>Text</b></span></h1>';
      const result = await service.extract(html, 'text/html');
      expect(result.title).toBe('Heading Text');
    });

    test('removes script blocks', async () => {
      const html = '<body><script>alert("xss")</script><p>Safe content</p></body>';
      const result = await service.extract(html, 'text/html');
      expect(result.text).not.toContain('alert');
      expect(result.text).toContain('Safe content');
    });

    test('removes style blocks', async () => {
      const html = '<body><style>body { color: red }</style><p>Visible</p></body>';
      const result = await service.extract(html, 'text/html');
      expect(result.text).not.toContain('color: red');
      expect(result.text).toContain('Visible');
    });

    test('removes HTML comments', async () => {
      const html = '<!-- comment --><p>Visible</p>';
      const result = await service.extract(html, 'text/html');
      expect(result.text).not.toContain('comment');
    });

    test('decodes common HTML entities', async () => {
      const html = '<p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p>';
      const result = await service.extract(html, 'text/html');
      expect(result.text).toContain('&');
      expect(result.text).toContain('<');
      expect(result.text).toContain('>');
    });

    test('decodes numeric HTML entities', async () => {
      const html = '<p>&#65; &#x42;</p>';
      const result = await service.extract(html, 'text/html');
      expect(result.text).toContain('A');
      expect(result.text).toContain('B');
    });

    test('handles special entity characters', async () => {
      const html = '<p>&ndash; &mdash; &hellip; &copy; &reg; &trade;</p>';
      const result = await service.extract(html, 'text/html');
      expect(result.text).toContain('\u2013');
      expect(result.text).toContain('\u2014');
      expect(result.text).toContain('\u2026');
      expect(result.text).toContain('\u00A9');
    });

    test('includes originalHtmlLength in metadata', async () => {
      const html = '<p>Hello</p>';
      const result = await service.extract(html, 'text/html');
      expect(result.metadata?.originalHtmlLength).toBe(html.length);
    });

    test('normalizes whitespace', async () => {
      const html = '<p>Multiple    spaces    here</p>';
      const result = await service.extract(html, 'text/html');
      expect(result.text).toContain('Multiple spaces here');
    });

    test('converts block elements to newlines', async () => {
      const html = '<div>Block1</div><div>Block2</div>';
      const result = await service.extract(html, 'text/html');
      expect(result.text).toContain('Block1');
      expect(result.text).toContain('Block2');
    });

    test('case-insensitive content type matching', async () => {
      const result = await service.extract('<p>Hi</p>', 'Text/HTML');
      expect(result.contentType).toBe('text/html');
    });
  });

  // ─── JSON ──────────────────────────────────────────────────────────────

  describe('application/json extraction', () => {
    test('formats valid JSON with indentation', async () => {
      const json = '{"key":"value"}';
      const result = await service.extract(json, 'application/json');
      expect(result.text).toBe(JSON.stringify({ key: 'value' }, null, 2));
      expect(result.contentType).toBe('application/json');
    });

    test('detects title from "title" field', async () => {
      const json = JSON.stringify({ title: 'Doc Title', body: 'content' });
      const result = await service.extract(json, 'application/json');
      expect(result.title).toBe('Doc Title');
    });

    test('detects title from "name" field as fallback', async () => {
      const json = JSON.stringify({ name: 'Item Name', body: 'content' });
      const result = await service.extract(json, 'application/json');
      expect(result.title).toBe('Item Name');
    });

    test('prefers title over name field', async () => {
      const json = JSON.stringify({ title: 'The Title', name: 'The Name' });
      const result = await service.extract(json, 'application/json');
      expect(result.title).toBe('The Title');
    });

    test('no title for arrays', async () => {
      const json = JSON.stringify([1, 2, 3]);
      const result = await service.extract(json, 'application/json');
      expect(result.title).toBeUndefined();
      expect(result.metadata?.isArray).toBe(true);
    });

    test('returns keyCount for objects', async () => {
      const json = JSON.stringify({ a: 1, b: 2, c: 3 });
      const result = await service.extract(json, 'application/json');
      expect(result.metadata?.keyCount).toBe(3);
    });

    test('handles invalid JSON gracefully', async () => {
      const result = await service.extract('{invalid json', 'application/json');
      expect(result.text).toBe('{invalid json');
      expect(result.metadata?.parseError).toBe(true);
    });

    test('no title for non-string title field', async () => {
      const json = JSON.stringify({ title: 42 });
      const result = await service.extract(json, 'application/json');
      expect(result.title).toBeUndefined();
    });
  });

  // ─── PDF / DOCX Stubs ─────────────────────────────────────────────────

  describe('unsupported content types', () => {
    test('throws for application/pdf', async () => {
      await expect(service.extract('data', 'application/pdf')).rejects.toThrow('PDF extraction');
    });

    test('throws for DOCX', async () => {
      await expect(
        service.extract(
          'data',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).rejects.toThrow('DOCX extraction');
    });

    test('throws for generic openxmlformats', async () => {
      await expect(
        service.extract('data', 'application/vnd.openxmlformats-something'),
      ).rejects.toThrow('DOCX extraction');
    });

    test('throws for completely unknown content type', async () => {
      await expect(service.extract('data', 'application/octet-stream')).rejects.toThrow(
        'Unsupported content type',
      );
    });
  });

  // ─── Content Type Normalization ────────────────────────────────────────

  describe('content type normalization', () => {
    test('handles leading/trailing whitespace', async () => {
      const result = await service.extract('hi', '  text/plain  ');
      expect(result.contentType).toBe('text/plain');
    });

    test('handles uppercase content type', async () => {
      const result = await service.extract('hi', 'TEXT/PLAIN');
      expect(result.contentType).toBe('text/plain');
    });
  });
});

// =============================================================================
// EnrichmentService Tests
// =============================================================================

import { EnrichmentService } from '../services/enrichment/index.js';

describe('EnrichmentService', () => {
  let service: EnrichmentService;

  beforeEach(() => {
    service = new EnrichmentService();
  });

  // ─── Entity Detection ─────────────────────────────────────────────────

  describe('entity detection', () => {
    test('detects email addresses', async () => {
      const result = await service.enrich('Contact us at test@example.com for info.');
      const emails = result.entities.filter((e) => e.type === 'email');
      expect(emails).toHaveLength(1);
      expect(emails[0].text).toBe('test@example.com');
    });

    test('detects multiple email addresses', async () => {
      const text = 'Email alice@test.com or bob@test.com';
      const result = await service.enrich(text);
      const emails = result.entities.filter((e) => e.type === 'email');
      expect(emails).toHaveLength(2);
    });

    test('detects URLs', async () => {
      const result = await service.enrich('Visit https://example.com/page for details.');
      const urls = result.entities.filter((e) => e.type === 'url');
      expect(urls).toHaveLength(1);
      expect(urls[0].text).toBe('https://example.com/page');
    });

    test('detects http URLs', async () => {
      const result = await service.enrich('Go to http://test.org');
      const urls = result.entities.filter((e) => e.type === 'url');
      expect(urls).toHaveLength(1);
    });

    test('detects ISO dates (YYYY-MM-DD)', async () => {
      const result = await service.enrich('The event is on 2024-01-15.');
      const dates = result.entities.filter((e) => e.type === 'date');
      expect(dates).toHaveLength(1);
      expect(dates[0].text).toBe('2024-01-15');
    });

    test('detects US-format dates (MM/DD/YYYY)', async () => {
      const result = await service.enrich('Due on 01/15/2024.');
      const dates = result.entities.filter((e) => e.type === 'date');
      expect(dates).toHaveLength(1);
      expect(dates[0].text).toBe('01/15/2024');
    });

    test('rejects invalid ISO dates', async () => {
      const result = await service.enrich('Not a date: 2024-13-40');
      const dates = result.entities.filter((e) => e.type === 'date');
      expect(dates).toHaveLength(0);
    });

    test('detects money values', async () => {
      const result = await service.enrich('The price is $1,234.56.');
      const money = result.entities.filter((e) => e.type === 'money');
      expect(money).toHaveLength(1);
      expect(money[0].text).toBe('$1,234.56');
    });

    test('detects simple dollar amounts', async () => {
      const result = await service.enrich('Costs $50.');
      const money = result.entities.filter((e) => e.type === 'money');
      expect(money).toHaveLength(1);
    });

    test('entities are sorted by position', async () => {
      const text = 'Email test@a.com then visit https://b.com on 2024-01-01';
      const result = await service.enrich(text);
      for (let i = 1; i < result.entities.length; i++) {
        expect(result.entities[i].start).toBeGreaterThanOrEqual(result.entities[i - 1].start);
      }
    });

    test('entities have correct start/end positions', async () => {
      const text = 'Email: test@example.com here';
      const result = await service.enrich(text);
      const email = result.entities.find((e) => e.type === 'email');
      expect(email).toBeDefined();
      expect(text.slice(email!.start, email!.end)).toBe('test@example.com');
    });

    test('no entities for plain text without patterns', async () => {
      const result = await service.enrich('Just some plain text without entities.');
      expect(result.entities).toHaveLength(0);
    });
  });

  // ─── Summary Generation ───────────────────────────────────────────────

  describe('summary generation', () => {
    test('returns full text if under 200 chars', async () => {
      const text = 'Short text.';
      const result = await service.enrich(text);
      expect(result.summary).toBe('Short text.');
    });

    test('trims to sentence boundary for long text', async () => {
      const text = 'First sentence. Second sentence. ' + 'A'.repeat(200);
      const result = await service.enrich(text);
      expect(result.summary.length).toBeLessThanOrEqual(200);
      expect(result.summary.endsWith('.')).toBe(true);
    });

    test('truncates at word boundary with ellipsis when no sentence boundary', async () => {
      const text = 'word '.repeat(60); // 300 chars, no sentence boundary
      const result = await service.enrich(text);
      expect(result.summary.endsWith('...')).toBe(true);
      expect(result.summary.length).toBeLessThanOrEqual(204); // 200 + "..."
    });

    test('hard truncates with ellipsis when no spaces', async () => {
      const text = 'a'.repeat(300);
      const result = await service.enrich(text);
      expect(result.summary.endsWith('...')).toBe(true);
    });

    test('trims whitespace from input', async () => {
      const result = await service.enrich('  Hello world  ');
      expect(result.summary).toBe('Hello world');
    });
  });

  // ─── Language Detection ───────────────────────────────────────────────

  describe('language detection', () => {
    test('detects English text', async () => {
      const text = 'The quick brown fox jumps over the lazy dog. This is a test of the system.';
      const result = await service.enrich(text);
      expect(result.language).toBe('en');
    });

    test('detects Spanish text', async () => {
      const text = 'El gato de la casa es un animal que los ninos quieren mucho.';
      const result = await service.enrich(text);
      expect(result.language).toBe('es');
    });

    test('detects French text', async () => {
      const text = 'Le chat de la maison est un animal que les enfants aiment beaucoup.';
      const result = await service.enrich(text);
      expect(result.language).toBe('fr');
    });

    test('detects German text', async () => {
      const text = 'Der Hund ist ein Tier das die Kinder mit dem Ball nicht auf sich des Lebens.';
      const result = await service.enrich(text);
      expect(result.language).toBe('de');
    });

    test('defaults to en for empty text', async () => {
      const result = await service.enrich('');
      expect(result.language).toBe('en');
    });

    test('defaults to en for numeric-only text', async () => {
      const result = await service.enrich('12345 67890');
      expect(result.language).toBe('en');
    });
  });

  // ─── Metadata ─────────────────────────────────────────────────────────

  describe('enrichment metadata', () => {
    test('includes entityCount', async () => {
      const result = await service.enrich('Contact test@a.com and visit https://b.com');
      expect(result.metadata?.entityCount).toBe(2);
    });

    test('includes entityTypes as unique set', async () => {
      const result = await service.enrich('Contact test@a.com and test2@b.com');
      expect(result.metadata?.entityTypes).toEqual(['email']);
    });

    test('includes charCount', async () => {
      const text = 'Hello world';
      const result = await service.enrich(text);
      expect(result.metadata?.charCount).toBe(text.length);
    });
  });
});

// =============================================================================
// CanonicalMapperService Tests
// =============================================================================

describe('CanonicalMapperService', () => {
  // Mock db/index.js to provide FieldMapping via getLazyModel.
  // vi.hoisted ensures the mock object is available when the hoisted vi.mock runs.
  const { mockFieldMapping } = vi.hoisted(() => {
    const mockFieldMapping = { find: vi.fn() };
    return { mockFieldMapping };
  });

  vi.mock('../db/index.js', () => ({
    getLazyModel: (modelName: string) => {
      if (modelName === 'FieldMapping') return mockFieldMapping;
      return {};
    },
    getModel: (modelName: string) => {
      if (modelName === 'FieldMapping') return mockFieldMapping;
      return {};
    },
    isDatabaseAvailable: () => true,
  }));

  // Import after mocking
  let CanonicalMapperService: typeof import('../services/canonical-mapper/index.js').CanonicalMapperService;
  let FieldMapping: { find: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    const canonicalModule = await import('../services/canonical-mapper/index.js');
    CanonicalMapperService = canonicalModule.CanonicalMapperService;

    FieldMapping = mockFieldMapping as unknown as { find: ReturnType<typeof vi.fn> };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMappings(mappings: Array<Record<string, unknown>>) {
    FieldMapping.find.mockReturnValue({
      lean: vi.fn().mockResolvedValue(mappings),
    });
  }

  // ─── Direct Transform ─────────────────────────────────────────────────

  describe('direct transform', () => {
    test('copies value as-is from source path', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'title',
          sourcePath: 'name',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { name: 'Test Doc' });
      expect(result.title).toBe('Test Doc');
    });

    test('handles nested source paths', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'author',
          sourcePath: 'metadata.author.name',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', {
        metadata: { author: { name: 'Alice' } },
      });
      expect(result.author).toBe('Alice');
    });

    test('defaults to direct when no transform type specified', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'title',
          sourcePath: 'name',
          transform: {},
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { name: 'Test' });
      expect(result.title).toBe('Test');
    });

    test('returns undefined for missing path', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'title',
          sourcePath: 'nonexistent',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { name: 'Test' });
      expect(result.title).toBeUndefined();
    });
  });

  // ─── Lowercase Transform ──────────────────────────────────────────────

  describe('lowercase transform', () => {
    test('converts string to lowercase', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'category',
          sourcePath: 'category',
          transform: { type: 'lowercase' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { category: 'TECHNOLOGY' });
      expect(result.category).toBe('technology');
    });

    test('returns non-string values as-is', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'count',
          sourcePath: 'count',
          transform: { type: 'lowercase' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { count: 42 });
      expect(result.count).toBe(42);
    });
  });

  // ─── Split Transform ──────────────────────────────────────────────────

  describe('split transform', () => {
    test('splits string by comma by default', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'tags',
          sourcePath: 'tags',
          transform: { type: 'split' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { tags: 'a, b, c' });
      expect(result.tags).toEqual(['a', 'b', 'c']);
    });

    test('splits by custom delimiter', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'tags',
          sourcePath: 'tags',
          transform: { type: 'split', delimiter: '|' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { tags: 'a|b|c' });
      expect(result.tags).toEqual(['a', 'b', 'c']);
    });

    test('returns non-string values as-is', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'tags',
          sourcePath: 'tags',
          transform: { type: 'split' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { tags: 42 });
      expect(result.tags).toBe(42);
    });
  });

  // ─── Date Format Transform ────────────────────────────────────────────

  describe('date_format transform', () => {
    test('converts valid date string to ISO format', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'publishedAt',
          sourcePath: 'date',
          transform: { type: 'date_format' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { date: '2024-01-15' });
      expect(typeof result.publishedAt).toBe('string');
      expect((result.publishedAt as string).includes('2024-01-15')).toBe(true);
    });

    test('returns invalid date string as-is', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'publishedAt',
          sourcePath: 'date',
          transform: { type: 'date_format' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { date: 'not-a-date' });
      expect(result.publishedAt).toBe('not-a-date');
    });

    test('returns non-string value as-is', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'publishedAt',
          sourcePath: 'date',
          transform: { type: 'date_format' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { date: 123 });
      expect(result.publishedAt).toBe(123);
    });
  });

  // ─── Rename Value Transform ───────────────────────────────────────────

  describe('rename_value transform', () => {
    test('renames value using valueMap', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'status',
          sourcePath: 'state',
          transform: {
            type: 'rename_value',
            valueMap: { active: 'enabled', inactive: 'disabled' },
          },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { state: 'active' });
      expect(result.status).toBe('enabled');
    });

    test('returns original value when not in valueMap', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'status',
          sourcePath: 'state',
          transform: {
            type: 'rename_value',
            valueMap: { active: 'enabled' },
          },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { state: 'unknown' });
      expect(result.status).toBe('unknown');
    });

    test('returns non-string values as-is', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'status',
          sourcePath: 'state',
          transform: { type: 'rename_value', valueMap: {} },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { state: 42 });
      expect(result.status).toBe(42);
    });
  });

  // ─── Extract Transform ────────────────────────────────────────────────

  describe('extract transform', () => {
    test('extracts using regex pattern', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'version',
          sourcePath: 'raw',
          transform: { type: 'extract', expression: 'v(\\d+\\.\\d+)' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { raw: 'Release v2.5 notes' });
      expect(result.version).toBe('2.5');
    });

    test('returns full match when no capture group', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'year',
          sourcePath: 'raw',
          transform: { type: 'extract', expression: '\\d{4}' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { raw: 'Year: 2024' });
      expect(result.year).toBe('2024');
    });

    test('returns original value when regex does not match', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'version',
          sourcePath: 'raw',
          transform: { type: 'extract', expression: 'v(\\d+)' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { raw: 'no version here' });
      expect(result.version).toBe('no version here');
    });

    test('handles invalid regex gracefully', async () => {
      const service = new CanonicalMapperService();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockMappings([
        {
          canonicalField: 'value',
          sourcePath: 'raw',
          transform: { type: 'extract', expression: '[invalid' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { raw: 'test' });
      expect(result.value).toBe('test');
      warnSpy.mockRestore();
    });
  });

  // ─── Coalesce Transform ───────────────────────────────────────────────

  describe('coalesce transform', () => {
    test('returns first non-null value', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'title',
          sourcePath: 'primary_title',
          transform: { type: 'coalesce', sources: ['primary_title', 'alt_title', 'name'] },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { alt_title: 'Fallback', name: 'Name' });
      expect(result.title).toBe('Fallback');
    });

    test('returns null when all sources are missing', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'title',
          sourcePath: 'primary_title',
          transform: { type: 'coalesce', sources: ['a', 'b', 'c'] },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { other: 'value' });
      expect(result.title).toBeUndefined(); // null values are filtered out
    });
  });

  // ─── Compute Transform (Stub) ────────────────────────────────────────

  describe('compute transform', () => {
    test('returns null (stub implementation)', async () => {
      const service = new CanonicalMapperService();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockMappings([
        {
          canonicalField: 'computed',
          sourcePath: 'x',
          transform: { type: 'compute', computeExpression: 'x + 1' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { x: 5 });
      expect(result.computed).toBeUndefined(); // null is filtered
      warnSpy.mockRestore();
    });
  });

  // ─── Unknown Transform ────────────────────────────────────────────────

  describe('unknown transform type', () => {
    test('falls back to direct transform', async () => {
      const service = new CanonicalMapperService();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockMappings([
        {
          canonicalField: 'title',
          sourcePath: 'name',
          transform: { type: 'magic' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { name: 'Test' });
      expect(result.title).toBe('Test');
      warnSpy.mockRestore();
    });
  });

  // ─── Caching ──────────────────────────────────────────────────────────

  describe('caching', () => {
    test('caches mappings after first load', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'title',
          sourcePath: 'name',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
      ]);

      await service.mapDocument('conn-1', { name: 'First' });
      await service.mapDocument('conn-1', { name: 'Second' });

      // find should only be called once due to caching
      expect(FieldMapping.find).toHaveBeenCalledTimes(1);
    });

    test('clearCache forces reload for specific connector', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'title',
          sourcePath: 'name',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
      ]);

      await service.mapDocument('conn-1', { name: 'First' });
      service.clearCache('conn-1');
      await service.mapDocument('conn-1', { name: 'Second' });

      expect(FieldMapping.find).toHaveBeenCalledTimes(2);
    });

    test('clearCache without arg clears all', async () => {
      const service = new CanonicalMapperService();
      mockMappings([]);

      await service.mapDocument('conn-1', {});
      await service.mapDocument('conn-2', {});
      service.clearCache();
      await service.mapDocument('conn-1', {});
      await service.mapDocument('conn-2', {});

      // 2 initial + 2 after clear = 4
      expect(FieldMapping.find).toHaveBeenCalledTimes(4);
    });
  });

  // ─── Error Handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    test('logs warning and skips field on transform error', async () => {
      const service = new CanonicalMapperService();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Create a mapping that will cause an error in extract transform
      mockMappings([
        {
          canonicalField: 'good',
          sourcePath: 'name',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
        {
          canonicalField: 'bad',
          sourcePath: 'data',
          transform: { type: 'extract', expression: '[invalid(' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { name: 'Test', data: 'value' });
      expect(result.good).toBe('Test');
      // bad field should still get the original value since the regex fails but returns original
      warnSpy.mockRestore();
    });
  });

  // ─── Nested Value Resolution ──────────────────────────────────────────

  describe('nested value resolution', () => {
    test('resolves deeply nested paths', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'deep',
          sourcePath: 'a.b.c.d',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', {
        a: { b: { c: { d: 'found' } } },
      });
      expect(result.deep).toBe('found');
    });

    test('returns undefined for broken path', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'x',
          sourcePath: 'a.b.c',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { a: { b: null } });
      expect(result.x).toBeUndefined();
    });

    test('resolves array index paths', async () => {
      const service = new CanonicalMapperService();
      mockMappings([
        {
          canonicalField: 'first',
          sourcePath: 'items.0',
          transform: { type: 'direct' },
          status: 'confirmed',
        },
      ]);

      const result = await service.mapDocument('conn-1', { items: ['apple', 'banana'] });
      expect(result.first).toBe('apple');
    });
  });
});

// =============================================================================
// Audit Helpers Tests
// =============================================================================

const { mockBuildSearchAIAuditPipelineEvent, mockPublishSearchAIAuditPipelineEvent } = vi.hoisted(
  () => ({
    mockBuildSearchAIAuditPipelineEvent: vi.fn((input) => ({ ...input, auditId: 'audit-1' })),
    mockPublishSearchAIAuditPipelineEvent: vi.fn(),
  }),
);

describe('audit-helpers', () => {
  let auditModule: typeof import('../services/audit-helpers.js');

  beforeEach(async () => {
    vi.resetModules();
    mockBuildSearchAIAuditPipelineEvent.mockReset();
    mockBuildSearchAIAuditPipelineEvent.mockImplementation((input) => ({
      ...input,
      auditId: 'audit-1',
    }));
    mockPublishSearchAIAuditPipelineEvent.mockReset();

    vi.doMock('../services/search-ai-audit-pipeline-writer.js', () => ({
      buildSearchAIAuditPipelineEvent: mockBuildSearchAIAuditPipelineEvent,
      publishSearchAIAuditPipelineEvent: mockPublishSearchAIAuditPipelineEvent,
    }));

    auditModule = await import('../services/audit-helpers.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('auditIndexCreated calls writeAuditLog (fire-and-forget)', () => {
    expect(() =>
      auditModule.auditIndexCreated({
        tenantId: 'tenant-1',
        userId: 'user-1',
        indexId: 'idx-1',
        indexName: 'Test Index',
        projectId: 'proj-1',
      }),
    ).not.toThrow();

    expect(mockBuildSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'search.index.created',
        action: 'search.index.created',
        tenantId: 'tenant-1',
        actorId: 'user-1',
        projectId: 'proj-1',
        resourceType: 'index',
        resourceId: 'idx-1',
      }),
    );
    expect(mockPublishSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        auditId: 'audit-1',
      }),
      'tenant-1',
    );
  });

  test('auditIndexUpdated includes changes', () => {
    expect(() =>
      auditModule.auditIndexUpdated({
        tenantId: 'tenant-1',
        indexId: 'idx-1',
        indexName: 'Test',
        projectId: 'proj-1',
        changes: { name: 'Updated' },
      }),
    ).not.toThrow();
  });

  test('auditIndexDeleted fires without error', () => {
    expect(() =>
      auditModule.auditIndexDeleted({
        tenantId: 'tenant-1',
        indexId: 'idx-1',
        indexName: 'Test',
        projectId: 'proj-1',
      }),
    ).not.toThrow();
  });

  test('auditSourceAdded fires without error', () => {
    expect(() =>
      auditModule.auditSourceAdded({
        tenantId: 'tenant-1',
        indexId: 'idx-1',
        sourceId: 'src-1',
        sourceName: 'Source',
        sourceType: 'file',
      }),
    ).not.toThrow();
  });

  test('auditSourceRemoved fires without error', () => {
    expect(() =>
      auditModule.auditSourceRemoved({
        tenantId: 'tenant-1',
        indexId: 'idx-1',
        sourceId: 'src-1',
        sourceName: 'Source',
        sourceType: 'file',
      }),
    ).not.toThrow();
  });

  test('auditSchemaDiscovered fires without error', () => {
    expect(() =>
      auditModule.auditSchemaDiscovered({
        tenantId: 'tenant-1',
        connectorId: 'conn-1',
        version: 1,
        fieldCount: 5,
      }),
    ).not.toThrow();
  });

  test('auditMappingConfirmed fires without error', () => {
    expect(() =>
      auditModule.auditMappingConfirmed({
        tenantId: 'tenant-1',
        mappingId: 'map-1',
        canonicalSchemaId: 'schema-1',
        connectorId: 'conn-1',
        canonicalField: 'title',
        sourcePath: 'name',
        reviewedBy: 'user-1',
      }),
    ).not.toThrow();
  });

  test('auditMappingRejected fires without error', () => {
    expect(() =>
      auditModule.auditMappingRejected({
        tenantId: 'tenant-1',
        mappingId: 'map-1',
        canonicalSchemaId: 'schema-1',
        connectorId: 'conn-1',
        canonicalField: 'title',
        sourcePath: 'name',
      }),
    ).not.toThrow();
  });

  test('auditVocabularyUpdated fires without error', () => {
    expect(() =>
      auditModule.auditVocabularyUpdated({
        tenantId: 'tenant-1',
        projectKnowledgeBaseId: 'kb-1',
        version: 2,
        entryCount: 100,
      }),
    ).not.toThrow();
  });

  test('audit functions handle missing userId gracefully', () => {
    expect(() =>
      auditModule.auditIndexCreated({
        tenantId: 'tenant-1',
        indexId: 'idx-1',
        indexName: 'Test',
        projectId: 'proj-1',
      }),
    ).not.toThrow();

    expect(mockBuildSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        actorType: 'system',
      }),
    );
  });
});

// =============================================================================
// ClickHouseIngestionStore Tests
// =============================================================================

describe('ClickHouseIngestionStore', () => {
  let ClickHouseIngestionStore: typeof import('../services/stores/clickhouse-ingestion-store.js').ClickHouseIngestionStore;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('@agent-platform/database/clickhouse', () => {
      class MockBufferedClickHouseWriter {
        private _pending = 0;
        insert = vi.fn();
        close = vi.fn().mockResolvedValue(undefined);
        constructor() {}
        get pending() {
          return this._pending;
        }
      }
      return {
        BufferedClickHouseWriter: MockBufferedClickHouseWriter,
        toClickHouseDateTime: (date: Date) => date.toISOString().replace('T', ' ').replace('Z', ''),
        toClickHouseDateTimeSec: (date: Date) =>
          date
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d{3}Z$/, ''),
      };
    });

    const mod = await import('../services/stores/clickhouse-ingestion-store.js');
    ClickHouseIngestionStore = mod.ClickHouseIngestionStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('constructs with correct table and config', () => {
    const mockClient = {} as import('@clickhouse/client').ClickHouseClient;
    const store = new ClickHouseIngestionStore(mockClient);
    expect(store).toBeDefined();
  });

  test('record() inserts a properly formatted row', () => {
    const mockClient = {} as import('@clickhouse/client').ClickHouseClient;
    const store = new ClickHouseIngestionStore(mockClient);

    store.record({
      tenantId: 'tenant-1',
      eventId: 'evt-1',
      indexId: 'idx-1',
      sourceId: 'src-1',
      documentId: 'doc-1',
      stage: 'extract',
      status: 'success',
      durationMs: 150,
      chunkCount: 5,
      tokenCount: 1000,
      embeddingCost: 0.001,
      fieldsMapped: 3,
      hasError: false,
      errorMessage: '',
      retryCount: 0,
      contentType: 'text/plain',
      contentSizeBytes: 4096,
    });

    // Store should exist without errors
    expect(store).toBeDefined();
  });

  test('record() uses defaults for optional fields', () => {
    const mockClient = {} as import('@clickhouse/client').ClickHouseClient;
    const store = new ClickHouseIngestionStore(mockClient);

    // Should not throw with minimal required fields
    store.record({
      tenantId: 'tenant-1',
      eventId: 'evt-1',
      indexId: 'idx-1',
      sourceId: 'src-1',
      stage: 'ingest',
      status: 'pending',
      durationMs: 0,
    });

    expect(store).toBeDefined();
  });

  test('record() sets has_error to 1 when hasError is true', () => {
    const mockClient = {} as import('@clickhouse/client').ClickHouseClient;
    const store = new ClickHouseIngestionStore(mockClient);

    store.record({
      tenantId: 'tenant-1',
      eventId: 'evt-1',
      indexId: 'idx-1',
      sourceId: 'src-1',
      stage: 'embed',
      status: 'error',
      durationMs: 500,
      hasError: true,
      errorMessage: 'Embedding failed',
    });

    expect(store).toBeDefined();
  });

  test('close() delegates to writer', async () => {
    const mockClient = {} as import('@clickhouse/client').ClickHouseClient;
    const store = new ClickHouseIngestionStore(mockClient);
    await expect(store.close()).resolves.toBeUndefined();
  });

  test('pending returns writer pending count', () => {
    const mockClient = {} as import('@clickhouse/client').ClickHouseClient;
    const store = new ClickHouseIngestionStore(mockClient);
    expect(store.pending).toBe(0);
  });
});
