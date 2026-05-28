/**
 * Rich Renderer Tests
 *
 * Tests for markdown rendering, HTML sanitization, hasRichContent,
 * and DOM rendering of actions and carousels.
 */

import { describe, test, expect } from 'vitest';
import { renderMarkdown, hasRichContent } from '../ui/rich-renderer.js';
import type { Message } from '../core/types.js';

// =============================================================================
// renderMarkdown
// =============================================================================

describe('renderMarkdown', () => {
  test('renders bold text', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  test('renders italic text', () => {
    const result = renderMarkdown('*italic*');
    expect(result).toContain('<em>italic</em>');
  });

  test('renders inline code', () => {
    expect(renderMarkdown('use `const x`')).toContain('<code>const x</code>');
  });

  test('renders code blocks', () => {
    const md = '```\nconst x = 1;\n```';
    const result = renderMarkdown(md);
    expect(result).toContain('<pre><code>');
    expect(result).toContain('const x = 1;');
  });

  test('renders links', () => {
    const result = renderMarkdown('[click](https://example.com)');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('>click</a>');
  });

  test('drops unsafe href values from markdown links', () => {
    const result = renderMarkdown('[click](javascript:alert(1))');
    expect(result).toContain('<a target="_blank" rel="noopener noreferrer">click</a>');
    expect(result).not.toContain('href="javascript:');
  });

  test('renders images', () => {
    const result = renderMarkdown('![alt](https://img.png)');
    expect(result).toContain('<img src="https://img.png"');
    expect(result).toContain('alt="alt"');
  });

  test('drops unsafe src values from markdown images', () => {
    const result = renderMarkdown('![alt](javascript:alert(1))');
    expect(result).toContain('<img alt="alt"');
    expect(result).not.toContain('src="javascript:');
  });

  test('renders h1 through h3', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>');
    expect(renderMarkdown('## Sub')).toContain('<h2>Sub</h2>');
    expect(renderMarkdown('### Third')).toContain('<h3>Third</h3>');
  });

  test('renders unordered lists', () => {
    const md = '- item 1\n- item 2';
    const result = renderMarkdown(md);
    expect(result).toBe('<ul><li>item 1</li><li>item 2</li></ul>');
  });

  test('renders ordered lists without nesting them inside unordered lists', () => {
    const md = '1. item 1\n2. item 2';
    const result = renderMarkdown(md);
    expect(result).toBe('<ol><li>item 1</li><li>item 2</li></ol>');
    expect(result).not.toContain('<ul><ol>');
  });

  test('renders markdown tables as semantic HTML tables', () => {
    const md = '| Name | Balance |\n| --- | --- |\n| Alice | $10 |\n| Bob | $20 |';
    const result = renderMarkdown(md);
    expect(result).toContain('<table>');
    expect(result).toContain('<thead><tr><th>Name</th><th>Balance</th></tr></thead>');
    expect(result).toContain('<tbody>');
    expect(result).toContain('<td>Alice</td>');
    expect(result).toContain('<td>$20</td>');
  });

  test('renders horizontal rules', () => {
    expect(renderMarkdown('---')).toContain('<hr />');
  });

  test('escapes HTML entities in input', () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  test('handles plain text without markdown', () => {
    const result = renderMarkdown('Hello world');
    expect(result).toContain('Hello world');
    expect(result).toContain('<p>');
  });

  test('preserves underscores in bare URLs without converting to emphasis', () => {
    const md = 'Download: https://tugo-com.cdn.prismic.io/tugo-com/696097fb_refund_form_2022.pdf';
    const result = renderMarkdown(md);
    expect(result).not.toContain('<em>');
    expect(result).toContain('696097fb_refund_form_2022.pdf');
    expect(result).toContain(
      'href="https://tugo-com.cdn.prismic.io/tugo-com/696097fb_refund_form_2022.pdf"',
    );
  });

  test('preserves underscores in markdown link URLs', () => {
    const md = '[Refund Form](https://example.com/path_with_underscores/file_name.pdf)';
    const result = renderMarkdown(md);
    expect(result).not.toContain('<em>');
    expect(result).toContain('href="https://example.com/path_with_underscores/file_name.pdf"');
    expect(result).toContain('>Refund Form</a>');
  });

  test('still applies italic formatting to regular underscore text', () => {
    const result = renderMarkdown('This is _italic_ text');
    expect(result).toContain('<em>italic</em>');
  });

  test('renders bare URLs as clickable links', () => {
    const md = 'Visit https://example.com/page for details';
    const result = renderMarkdown(md);
    expect(result).toContain('<a href="https://example.com/page"');
    expect(result).toContain('target="_blank"');
  });
});

// =============================================================================
// hasRichContent
// =============================================================================

describe('hasRichContent', () => {
  test('returns false for plain text message', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Hello',
      timestamp: new Date(),
    };
    expect(hasRichContent(msg)).toBe(false);
  });

  test('returns true for message with markdown', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Hello',
      timestamp: new Date(),
      richContent: { markdown: '**Hello**' },
    };
    expect(hasRichContent(msg)).toBe(true);
  });

  test('returns true for message with HTML', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Hello',
      timestamp: new Date(),
      richContent: { html: '<b>Hello</b>' },
    };
    expect(hasRichContent(msg)).toBe(true);
  });

  test('returns true for message with unsupported channel-specific rich content', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: { slack: '{"text":"Hello from Slack"}' },
    };
    expect(hasRichContent(msg)).toBe(true);
  });

  test('returns true for message with carousel', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Products',
      timestamp: new Date(),
      richContent: {
        carousel: {
          cards: [{ title: 'Card 1' }],
        },
      },
    };
    expect(hasRichContent(msg)).toBe(true);
  });

  test('returns true for message with actions', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Choose',
      timestamp: new Date(),
      actions: {
        elements: [{ id: 'btn', type: 'button', label: 'Click' }],
      },
    };
    expect(hasRichContent(msg)).toBe(true);
  });

  test('returns false for empty richContent', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Hello',
      timestamp: new Date(),
      richContent: {},
    };
    expect(hasRichContent(msg)).toBe(false);
  });

  test('returns false for actions with empty elements array', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Hello',
      timestamp: new Date(),
      actions: { elements: [] },
    };
    expect(hasRichContent(msg)).toBe(false);
  });

  test('returns true for message with both richContent and actions', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Choose',
      timestamp: new Date(),
      richContent: { markdown: '**Choose one:**' },
      actions: {
        elements: [{ id: 'a', type: 'button', label: 'A' }],
      },
    };
    expect(hasRichContent(msg)).toBe(true);
  });

  test('returns false for carousel with empty cards array', () => {
    const msg: Message = {
      id: '1',
      role: 'assistant',
      content: 'Products',
      timestamp: new Date(),
      richContent: {
        carousel: { cards: [] },
      },
    };
    // Carousel with empty cards has no visual content
    expect(hasRichContent(msg)).toBe(false);
  });
});
