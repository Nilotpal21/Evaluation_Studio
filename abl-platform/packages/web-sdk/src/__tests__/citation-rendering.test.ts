/**
 * Citation Rendering Tests
 *
 * Tests for citation pill injection, HTML sanitization, and CitationList component.
 * Uses happy-dom environment (vitest config for web-sdk).
 *
 * Business logic covered:
 * - [N] marker replacement with citation pill anchors
 * - Post-markdown injection timing (no HTML escaping of pills)
 * - Title escaping for XSS safety
 * - Sanitizer preserving class/title on <a> tags
 * - CitationList filtering and rendering
 */

import { describe, test, expect } from 'vitest';
import { renderMarkdown, sanitizeHtml } from '../ui/rich-renderer.js';

// ─── injectCitationPills (tested via the full MarkdownContent pipeline) ─────
// Since injectCitationPills is not exported directly, we test it through the
// full renderMarkdown → inject → sanitizeHtml pipeline that MarkdownContent uses.

interface CitationRef {
  index: number;
  title: string;
  url: string;
}

/**
 * Replicate the injectCitationPills logic from MarkdownContent.tsx
 * for direct unit testing.
 */
function injectCitationPills(html: string, citations: CitationRef[]): string {
  return html.replace(/\s*\[(\d+)\]/g, (_match, num) => {
    const idx = parseInt(num, 10);
    const citation = citations.find((c) => c.index === idx);
    if (!citation) return _match;
    const title = citation.title || `Source ${idx}`;
    const safeTitle = title.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return (
      `<a href="${citation.url}" target="_blank" rel="noopener noreferrer" ` +
      `class="sdk-citation-pill" title="${safeTitle}">` +
      `${idx}</a>`
    );
  });
}

describe('injectCitationPills', () => {
  const citations: CitationRef[] = [
    { index: 1, title: 'Resume.pdf', url: 'https://example.com/doc1' },
    { index: 2, title: 'Report.docx', url: 'https://example.com/doc2' },
    { index: 3, title: 'Data Sheet', url: 'https://example.com/doc3' },
  ];

  test('replaces [1] with citation pill anchor', () => {
    const html = '<p>This is from source [1].</p>';
    const result = injectCitationPills(html, citations);
    expect(result).toContain('class="sdk-citation-pill"');
    expect(result).toContain('href="https://example.com/doc1"');
    expect(result).toContain('>1</a>');
  });

  test('replaces multiple [1][2][3] markers', () => {
    const html = '<p>See [1] and [2] and [3].</p>';
    const result = injectCitationPills(html, citations);
    expect(result).toContain('>1</a>');
    expect(result).toContain('>2</a>');
    expect(result).toContain('>3</a>');
    expect(result).not.toContain('[1]');
    expect(result).not.toContain('[2]');
    expect(result).not.toContain('[3]');
  });

  test('leaves unmatched [N] as-is (no matching citation)', () => {
    const html = '<p>See [1] and [99].</p>';
    const result = injectCitationPills(html, citations);
    expect(result).toContain('>1</a>');
    expect(result).toContain('[99]'); // No citation with index 99
  });

  test('escapes title with special characters (" < >)', () => {
    const dangerousCitations: CitationRef[] = [
      { index: 1, title: 'File "important" <script>', url: 'https://example.com/x' },
    ];
    const html = '<p>Source [1].</p>';
    const result = injectCitationPills(html, dangerousCitations);
    expect(result).toContain('&quot;');
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
    expect(result).not.toContain('"important"');
    expect(result).not.toContain('<script>');
  });

  test('handles citations with page-level URLs (#page=3)', () => {
    const pageCitations: CitationRef[] = [
      { index: 1, title: 'Doc.pdf (p. 3)', url: 'https://example.com/doc.pdf#page=3' },
    ];
    const html = '<p>Reference [1].</p>';
    const result = injectCitationPills(html, pageCitations);
    expect(result).toContain('href="https://example.com/doc.pdf#page=3"');
  });

  test('works inside rendered markdown HTML (inside <p>, <li>, etc.)', () => {
    // Simulate what renderMarkdown produces
    const html = '<ul><li>First point [1]</li><li>Second point [2]</li></ul>';
    const result = injectCitationPills(html, citations);
    expect(result).toContain('<li>First point');
    expect(result).toContain('>1</a></li>');
    expect(result).toContain('>2</a></li>');
  });

  test('handles adjacent citations [1][2] without space', () => {
    const html = '<p>Combined sources[1][2].</p>';
    const result = injectCitationPills(html, citations);
    expect(result).toContain('>1</a>');
    expect(result).toContain('>2</a>');
  });

  test('handles citations in middle of sentence', () => {
    const html = '<p>The data [1] shows that performance [2] improved.</p>';
    const result = injectCitationPills(html, citations);
    expect(result).toContain('The data');
    expect(result).toContain('>1</a>');
    expect(result).toContain('shows that performance');
    expect(result).toContain('>2</a>');
  });

  test('does not match [text] that is not a number', () => {
    const html = '<p>See [one] and [reference] but [1] works.</p>';
    const result = injectCitationPills(html, citations);
    expect(result).toContain('[one]');
    expect(result).toContain('[reference]');
    expect(result).toContain('>1</a>');
  });
});

describe('sanitizeHtml with citation pills', () => {
  test('preserves class attribute on citation <a> tags', () => {
    const html = '<a href="https://x.com" class="sdk-citation-pill" title="Doc">1</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('class="sdk-citation-pill"');
  });

  test('preserves title attribute on citation <a> tags', () => {
    const html = '<a href="https://x.com" class="sdk-citation-pill" title="My Document">1</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('title="My Document"');
  });

  test('preserves href, target, rel on citation <a> tags', () => {
    const html =
      '<a href="https://x.com/doc" target="_blank" rel="noopener noreferrer" class="sdk-citation-pill">1</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('href="https://x.com/doc"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  test('strips script tags even with class attribute', () => {
    const html = '<script class="sdk-citation-pill">alert("xss")</script>';
    const result = sanitizeHtml(html);
    // DOMPurify with KEEP_CONTENT: true preserves text content but strips the tag
    expect(result).not.toContain('<script');
    expect(result).not.toContain('</script');
  });

  test('strips javascript: URLs from citation-like links', () => {
    const html = '<a href="javascript:alert(1)" class="sdk-citation-pill">1</a>';
    const result = sanitizeHtml(html);
    // href should be removed but element may survive
    expect(result).not.toContain('javascript:');
  });
});

describe('Full citation pipeline: renderMarkdown → inject → sanitize', () => {
  const citations: CitationRef[] = [
    { index: 1, title: 'Source A', url: 'https://example.com/a' },
    { index: 2, title: 'Source B', url: 'https://example.com/b' },
  ];

  test('produces working citation pills from markdown with [N] markers', () => {
    const markdown = 'The answer is **yes** [1]. Also see [2] for more details.';
    let rendered = renderMarkdown(markdown);
    rendered = injectCitationPills(rendered, citations);
    const final = sanitizeHtml(rendered);

    // Should have bold text
    expect(final).toContain('<strong>yes</strong>');
    // Should have citation pills (not raw [1])
    expect(final).toContain('class="sdk-citation-pill"');
    expect(final).toContain('>1</a>');
    expect(final).toContain('>2</a>');
    expect(final).not.toContain('[1]');
    expect(final).not.toContain('[2]');
  });

  test('handles complex markdown with lists, code, and citations', () => {
    const markdown = `Skills include:
- Python [1]
- JavaScript [2]
- \`TypeScript\` [1]`;

    let rendered = renderMarkdown(markdown);
    rendered = injectCitationPills(rendered, citations);
    const final = sanitizeHtml(rendered);

    expect(final).toContain('<ul>');
    expect(final).toContain('<li>');
    expect(final).toContain('<code>TypeScript</code>');
    expect(final).toContain('class="sdk-citation-pill"');
  });

  test('preserves unmatched [N] when no citation exists', () => {
    const markdown = 'Data from [1] and [5] sources.';
    let rendered = renderMarkdown(markdown);
    rendered = injectCitationPills(rendered, citations);
    const final = sanitizeHtml(rendered);

    expect(final).toContain('>1</a>'); // matched
    expect(final).toContain('[5]'); // unmatched - preserved as text
  });
});
