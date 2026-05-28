/**
 * sanitizeHtml Tests
 *
 * Verifies the HTML sanitizer strips disallowed tags, attributes,
 * and javascript: URLs while preserving allowed content.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sanitizeHtml } from '../ui/rich-renderer.js';
import { ChatWidget } from '../ui/ChatWidget.js';
import { UnifiedWidget } from '../ui/UnifiedWidget.js';
import { VoiceWidget } from '../ui/VoiceWidget.js';

// =============================================================================
// Allowed tags pass through
// =============================================================================

describe('sanitizeHtml — allowed tags', () => {
  test('preserves basic formatting tags', () => {
    const html = '<p>Hello <strong>bold</strong> and <em>italic</em></p>';
    const result = sanitizeHtml(html);
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
  });

  test('preserves headings', () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2>';
    const result = sanitizeHtml(html);
    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('<h2>Subtitle</h2>');
  });

  test('preserves lists', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    const result = sanitizeHtml(html);
    expect(result).toContain('<li>Item 1</li>');
    expect(result).toContain('<li>Item 2</li>');
  });

  test('preserves tables', () => {
    const html =
      '<table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Val</td></tr></tbody></table>';
    const result = sanitizeHtml(html);
    expect(result).toContain('<th>Col</th>');
    expect(result).toContain('<td>Val</td>');
  });

  test('preserves links with href', () => {
    const html = '<a href="https://example.com">Link</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('>Link</a>');
  });

  test('preserves images with src and alt', () => {
    const html = '<img src="https://img.png" alt="photo">';
    const result = sanitizeHtml(html);
    expect(result).toContain('src="https://img.png"');
    expect(result).toContain('alt="photo"');
  });

  test('preserves code blocks', () => {
    const html = '<pre><code>const x = 1;</code></pre>';
    const result = sanitizeHtml(html);
    expect(result).toContain('<pre><code>const x = 1;</code></pre>');
  });
});

// =============================================================================
// Disallowed tags stripped
// =============================================================================

describe('sanitizeHtml — disallowed tags', () => {
  test('strips <script> tags', () => {
    const html = '<p>Hello</p><script>alert("xss")</script>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<script>');
    expect(result).toContain('Hello');
  });

  test('strips <style> tags', () => {
    const html = '<style>body{display:none}</style><p>Content</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<style>');
    expect(result).toContain('Content');
  });

  test('strips <iframe> tags', () => {
    const html = '<iframe src="https://evil.com"></iframe><p>Safe</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<iframe');
    expect(result).toContain('Safe');
  });

  test('strips <form> tags', () => {
    const html = '<form action="https://evil.com"><input></form>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<form');
  });

  test('strips <object> and <embed> tags', () => {
    const html = '<object data="x.swf"></object><embed src="x.swf">';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<object');
    expect(result).not.toContain('<embed');
  });
});

// =============================================================================
// Attribute stripping
// =============================================================================

describe('sanitizeHtml — attribute stripping', () => {
  test('strips onclick from allowed tags', () => {
    const html = '<p onclick="alert(1)">Click</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('onclick');
    expect(result).toContain('Click');
  });

  test('strips onerror from img', () => {
    const html = '<img src="x.png" onerror="alert(1)">';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('onerror');
    expect(result).toContain('src="x.png"');
  });

  test('strips style from non-img tags', () => {
    const html = '<p style="color:red">Styled</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('style=');
    expect(result).toContain('Styled');
  });

  test('strips class and id attributes', () => {
    const html = '<div class="evil" id="target">Content</div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('class=');
    expect(result).not.toContain('id=');
  });

  test('preserves colspan/rowspan on td and th', () => {
    const html = '<table><tr><td colspan="2">Wide</td></tr></table>';
    const result = sanitizeHtml(html);
    expect(result).toContain('colspan="2"');
  });
});

// =============================================================================
// javascript: URL blocking
// =============================================================================

describe('sanitizeHtml — javascript: URL blocking', () => {
  test('blocks javascript: in href', () => {
    const html = '<a href="javascript:alert(1)">Evil</a>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('javascript:');
  });

  test('blocks javascript: in img src', () => {
    const html = '<img src="javascript:alert(1)">';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('javascript:');
  });

  test('blocks javascript: with leading spaces', () => {
    const html = '<a href="  javascript:alert(1)">Tricky</a>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('javascript:');
  });

  test('blocks JAVASCRIPT: (case insensitive)', () => {
    const html = '<a href="JAVASCRIPT:alert(1)">Upper</a>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('JAVASCRIPT:');
    expect(result).not.toContain('javascript:');
  });
});

// =============================================================================
// Link behavior
// =============================================================================

describe('sanitizeHtml — link behavior', () => {
  test('adds target="_blank" to links', () => {
    const html = '<a href="https://example.com">Link</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('target="_blank"');
  });

  test('adds rel="noopener noreferrer" to links', () => {
    const html = '<a href="https://example.com">Link</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('rel="noopener noreferrer"');
  });

  test('overwrites existing target on links', () => {
    const html = '<a href="https://example.com" target="_self">Link</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('target="_blank"');
    expect(result).not.toContain('target="_self"');
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('sanitizeHtml — edge cases', () => {
  test('handles empty string', () => {
    expect(sanitizeHtml('')).toBe('');
  });

  test('handles plain text (no HTML)', () => {
    const result = sanitizeHtml('Just text');
    expect(result).toContain('Just text');
  });

  test('handles nested disallowed tags', () => {
    const html = '<div><script>nested</script></div>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<script>');
  });

  test('removes HTML comments', () => {
    const html = '<p>Before</p><!-- comment --><p>After</p>';
    const result = sanitizeHtml(html);
    expect(result).not.toContain('<!--');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });
});

// =============================================================================
// Widget rendering sinks
// =============================================================================

describe('widget rendering — XSS regression coverage', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', class MockAudioContext {});
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function configureUnifiedVoiceWidget(widget: UnifiedWidget): void {
    widget.setAttribute('mode', 'unified');
    widget.setAttribute('chat-enabled', 'true');
    widget.setAttribute('voice-enabled', 'true');
    (widget as any).sdk = {
      getSessionScope: () => ({ showActivityUpdates: true }),
    };
  }

  function configureVoiceWidget(widget: VoiceWidget): void {
    widget.setAttribute('voice-enabled', 'true');
    widget.setAttribute('project-id', 'proj_123');
    widget.setAttribute('api-key', 'pk_test');
    widget.setAttribute('endpoint', 'https://example.com');
    widget.setAttribute('show-panel', 'true');
    (widget as any).sdk = {
      getSessionScope: () => ({ showActivityUpdates: true }),
    };
  }

  test('ChatWidget sanitizes welcome-message HTML and escapes placeholder attributes', () => {
    const widget = new ChatWidget();
    widget.setAttribute('welcome-message', '<strong>Hello</strong><script>alert(1)</script>');
    widget.setAttribute('placeholder', 'Say "hi" autofocus onfocus="alert(2)');

    (widget as any).isMinimized = false;
    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const messageEl = shadow.querySelector('.message.assistant') as HTMLElement;
    const input = shadow.querySelector('.input-field') as HTMLInputElement;

    expect(messageEl.querySelector('script')).toBeNull();
    expect(messageEl.querySelector('strong')?.textContent).toBe('Hello');
    expect(input.placeholder).toBe('Say "hi" autofocus onfocus="alert(2)');
    expect(input.getAttribute('onfocus')).toBeNull();
    expect(input.hasAttribute('autofocus')).toBe(false);
  });

  test('UnifiedWidget sanitizes welcome-message HTML and escapes placeholder attributes', () => {
    const widget = new UnifiedWidget();
    widget.setAttribute('mode', 'chat');
    widget.setAttribute('chat-enabled', 'true');
    widget.setAttribute('welcome-message', '<strong>Hello</strong><script>alert(1)</script>');
    widget.setAttribute('placeholder', 'Say "hi" autofocus onfocus="alert(2)');

    (widget as any).isMinimized = false;
    (widget as any).currentMode = 'chat';
    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const messageEl = shadow.querySelector('.message.assistant') as HTMLElement;
    const input = shadow.querySelector('.input-field') as HTMLInputElement;

    expect(messageEl.querySelector('script')).toBeNull();
    expect(messageEl.querySelector('strong')?.textContent).toBe('Hello');
    expect(input.placeholder).toBe('Say "hi" autofocus onfocus="alert(2)');
    expect(input.getAttribute('onfocus')).toBeNull();
    expect(input.hasAttribute('autofocus')).toBe(false);
  });

  test('UnifiedWidget escapes transcript and status text while sanitizing thought content', () => {
    const widget = new UnifiedWidget();
    configureUnifiedVoiceWidget(widget);

    (widget as any).isMinimized = false;
    (widget as any).currentMode = 'voice';
    (widget as any).currentTranscript = '<img src=x onerror="alert(1)">';
    (widget as any).statusMessage = '<svg onload="alert(2)"></svg>Status';
    (widget as any).lastThought = {
      toolName: 'search',
      thought: '<strong>Thinking</strong><script>alert(3)</script>',
      reasoning: 'reasoning',
      agent: 'agent',
    };
    (widget as any).render();

    const shadow = widget.shadowRoot!;
    const transcriptEl = shadow.querySelector('.transcript.user') as HTMLElement;
    const statusEl = shadow.querySelector('.status-message') as HTMLElement;
    const thoughtEl = shadow.querySelector('.thought-display') as HTMLElement;

    expect(transcriptEl.querySelector('img')).toBeNull();
    expect(transcriptEl.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(statusEl.querySelector('svg')).toBeNull();
    expect(statusEl.textContent).toContain('<svg onload="alert(2)"></svg>Status');
    expect(thoughtEl.querySelector('script')).toBeNull();
    expect(thoughtEl.querySelector('strong')?.textContent).toBe('Thinking');
  });

  test('VoiceWidget escapes transcript and response text while sanitizing companion panel content', () => {
    const widget = new VoiceWidget();
    configureVoiceWidget(widget);

    (widget as any).currentState = 'speaking';
    (widget as any).currentTranscript = '<img src=x onerror="alert(1)">';
    (widget as any).statusMessage = '<svg onload="alert(2)"></svg>Status';
    (widget as any).lastThought = {
      toolName: 'search',
      thought: '<strong>Thinking</strong><script>alert(3)</script>',
      reasoning: 'reasoning',
      agent: 'agent',
    };
    (widget as any).render();

    let shadow = widget.shadowRoot!;
    let transcriptEl = shadow.querySelector('.transcript.user') as HTMLElement;
    let statusEl = shadow.querySelector('.status-message') as HTMLElement;
    let thoughtEl = shadow.querySelector('.thought-display') as HTMLElement;

    expect(transcriptEl.querySelector('img')).toBeNull();
    expect(transcriptEl.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(statusEl.querySelector('svg')).toBeNull();
    expect(statusEl.textContent).toContain('<svg onload="alert(2)"></svg>Status');
    expect(thoughtEl.querySelector('script')).toBeNull();
    expect(thoughtEl.querySelector('strong')?.textContent).toBe('Thinking');

    (widget as any).currentTranscript = '';
    (widget as any).lastResponse = '<img src=x onerror="alert(4)">';
    (widget as any).render();

    shadow = widget.shadowRoot!;
    transcriptEl = shadow.querySelector('.transcript') as HTMLElement;
    expect(transcriptEl.querySelector('img')).toBeNull();
    expect(transcriptEl.textContent).toContain('<img src=x onerror="alert(4)">');
  });
});
