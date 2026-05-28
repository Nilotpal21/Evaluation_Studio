import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatClient } from '../chat/ChatClient.js';
import type { Message } from '../core/types.js';

interface WidgetHarness {
  messagesEl: HTMLElement | null;
  chat: ChatClient | null;
  addMessage: (message: Message) => void;
  appendToLastMessage: (messageId: string, chunk: string) => void;
}

function prepareHarness<T extends HTMLElement>(widget: T): WidgetHarness {
  const harness = widget as unknown as WidgetHarness;
  harness.messagesEl = document.createElement('div');
  harness.chat = {
    submitFeedback: vi.fn().mockResolvedValue({ feedbackId: 'fb-widget' }),
  } as unknown as ChatClient;
  return harness;
}

describe('widget rich content rendering', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('ChatWidget renders ActionSet controls when imported directly from the widget entry', async () => {
    const { ChatWidget } = await import('../ui/ChatWidget.js');
    const harness = prepareHarness(new ChatWidget());

    harness.addMessage({
      id: 'assistant-actions',
      role: 'assistant',
      content: 'Choose an option',
      timestamp: new Date(),
      actions: {
        elements: [{ id: 'approve', type: 'button', label: 'Approve' }],
      },
    });

    const messageEl = harness.messagesEl?.querySelector(
      '.message.assistant.rich[data-id="assistant-actions"]',
    );
    expect(messageEl?.querySelector('.rich-text')?.textContent).toContain('Choose an option');
    expect(messageEl?.querySelector('.rich-actions')).not.toBeNull();
    expect(messageEl?.querySelector('.rich-btn')?.textContent).toBe('Approve');
  });

  test('ChatWidget renders plain-message feedback only when enable-feedback is set', async () => {
    const { ChatWidget } = await import('../ui/ChatWidget.js');
    const disabledWidget = document.createElement('agent-chat') as InstanceType<typeof ChatWidget>;
    const disabledHarness = prepareHarness(disabledWidget);

    disabledHarness.addMessage({
      id: 'assistant-feedback-disabled',
      role: 'assistant',
      content: 'Feedback should not render by default.',
      timestamp: new Date(),
    });

    expect(disabledHarness.messagesEl?.querySelector('.message-feedback')).toBeNull();

    const enabledWidget = document.createElement('agent-chat') as InstanceType<typeof ChatWidget>;
    enabledWidget.setAttribute('enable-feedback', 'true');
    const enabledHarness = prepareHarness(enabledWidget);

    enabledHarness.addMessage({
      id: 'assistant-feedback-enabled',
      role: 'assistant',
      content: 'Feedback should render when enabled.',
      timestamp: new Date(),
    });

    const feedback = enabledHarness.messagesEl?.querySelector('.message-feedback');
    expect(feedback).not.toBeNull();

    const thumbsUp = feedback?.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]');
    thumbsUp?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(enabledHarness.chat?.submitFeedback).toHaveBeenCalledWith({
      messageId: 'assistant-feedback-enabled',
      ratingType: 'thumbs',
      ratingValue: 1,
    });
    expect(feedback?.textContent).toContain('Thanks for the feedback');
  });

  test('ChatWidget uses generic text for unknown feedback failures', async () => {
    const { ChatWidget } = await import('../ui/ChatWidget.js');
    const widget = document.createElement('agent-chat') as InstanceType<typeof ChatWidget>;
    widget.setAttribute('enable-feedback', 'true');
    const harness = prepareHarness(widget);
    const rawError = 'tenant tenant_123 model internal-model credential missing';
    harness.chat = {
      submitFeedback: vi.fn().mockRejectedValue(new Error(rawError)),
    } as unknown as ChatClient;

    harness.addMessage({
      id: 'assistant-feedback-unknown-error',
      role: 'assistant',
      content: 'Feedback should hide raw errors.',
      timestamp: new Date(),
    });

    const feedback = harness.messagesEl?.querySelector('.message-feedback');
    feedback?.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(feedback?.textContent).toContain('Could not send feedback');
    expect(feedback?.textContent).not.toContain(rawError);
  });

  test('UnifiedWidget renders markdown tables when imported directly from the widget entry', async () => {
    const { UnifiedWidget } = await import('../ui/UnifiedWidget.js');
    const harness = prepareHarness(new UnifiedWidget());

    harness.addMessage({
      id: 'assistant-table',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      richContent: {
        markdown: '| Metric | Value |\n| --- | --- |\n| Revenue | $42 |',
      },
    });

    const messageEl = harness.messagesEl?.querySelector(
      '.message.assistant.rich[data-id="assistant-table"]',
    );
    const table = messageEl?.querySelector('.rich-text table');
    expect(table).not.toBeNull();
    expect(table?.querySelector('th')?.textContent).toBe('Metric');
    expect(table?.querySelector('td')?.textContent).toBe('Revenue');
  });

  test('UnifiedWidget enabled feedback captures thumbs-down comments', async () => {
    const { UnifiedWidget } = await import('../ui/UnifiedWidget.js');
    const widget = document.createElement('agent-widget') as InstanceType<typeof UnifiedWidget>;
    widget.setAttribute('enable-feedback', 'true');
    const harness = prepareHarness(widget);

    harness.addMessage({
      id: 'unified-feedback-comment',
      role: 'assistant',
      content: 'Plain unified answer.',
      timestamp: new Date(),
    });

    const feedback = harness.messagesEl?.querySelector('.message-feedback');
    expect(feedback).not.toBeNull();

    feedback?.querySelector<HTMLButtonElement>('button[aria-label="Thumbs down"]')?.click();
    const textarea = feedback?.querySelector<HTMLTextAreaElement>(
      '.message-feedback-comment-input',
    );
    expect(textarea).toBeTruthy();
    if (textarea) {
      textarea.value = 'Needs more detail';
    }
    feedback?.querySelector<HTMLButtonElement>('.message-feedback-primary-btn')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.chat?.submitFeedback).toHaveBeenCalledWith({
      messageId: 'unified-feedback-comment',
      ratingType: 'thumbs',
      ratingValue: 0,
      feedbackText: 'Needs more detail',
    });
    expect(feedback?.textContent).toContain('Feedback recorded');
  });

  // ABLP-1189: UnifiedWidget was falling through to textContent for plain
  // assistant content, so customers using <agent-widget> saw raw markdown
  // (paragraphs collapsed, links not clickable, bullets shown as `*`).
  test('UnifiedWidget renders markdown links, paragraphs, and lists for plain assistant content', async () => {
    const { UnifiedWidget } = await import('../ui/UnifiedWidget.js');
    const harness = prepareHarness(new UnifiedWidget());

    harness.addMessage({
      id: 'assistant-md',
      role: 'assistant',
      content: [
        'To open a ticket, sign in via [the support portal](https://portal.example.com/login).',
        '',
        'A few important points:',
        '',
        '* Request forms are available in the portal.',
        '* Upload your completed and signed forms.',
      ].join('\n'),
      timestamp: new Date(),
    });

    const messageEl = harness.messagesEl?.querySelector<HTMLElement>(
      '.message.assistant[data-id="assistant-md"]',
    );
    expect(messageEl).not.toBeNull();
    expect(messageEl?.classList.contains('rich')).toBe(false);

    const link = messageEl?.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe('https://portal.example.com/login');
    expect(link?.textContent).toBe('the support portal');

    expect(messageEl?.querySelectorAll('p').length).toBeGreaterThanOrEqual(2);
    expect(messageEl?.querySelector('ul')).not.toBeNull();
    expect(messageEl?.querySelectorAll('li').length).toBe(2);
  });

  test('UnifiedWidget streams markdown chunks as formatted output', async () => {
    const { UnifiedWidget } = await import('../ui/UnifiedWidget.js');
    const harness = prepareHarness(new UnifiedWidget());

    harness.appendToLastMessage('msg-stream', 'Click [here](https://example.com) ');
    harness.appendToLastMessage('msg-stream', 'for **details**.');

    const streamingEl = harness.messagesEl?.querySelector<HTMLElement>(
      '.message.streaming[data-id="msg-stream"]',
    );
    expect(streamingEl).not.toBeNull();
    expect(streamingEl?.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe(
      'https://example.com',
    );
    expect(streamingEl?.querySelector('strong')?.textContent).toBe('details');
  });
});

// ABLP-1189 — exhaustive permutations for UnifiedWidget markdown rendering.
// Each test mounts a fresh widget so DOM state never leaks between cases.
describe('UnifiedWidget markdown — permutation coverage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  let messageCounter = 0;

  async function renderAssistant(content: string): Promise<HTMLElement> {
    const { UnifiedWidget } = await import('../ui/UnifiedWidget.js');
    const harness = prepareHarness(new UnifiedWidget());
    const id = `msg-${++messageCounter}`;
    harness.addMessage({ id, role: 'assistant', content, timestamp: new Date() });
    const el = harness.messagesEl?.querySelector<HTMLElement>(
      `.message.assistant[data-id="${id}"]`,
    );
    if (!el) throw new Error(`no message element rendered for ${id}`);
    return el;
  }

  async function streamChunks(chunks: string[]): Promise<HTMLElement> {
    const { UnifiedWidget } = await import('../ui/UnifiedWidget.js');
    const harness = prepareHarness(new UnifiedWidget());
    const id = `stream-${++messageCounter}`;
    for (const chunk of chunks) {
      harness.appendToLastMessage(id, chunk);
    }
    const el = harness.messagesEl?.querySelector<HTMLElement>(
      `.message.streaming[data-id="${id}"]`,
    );
    if (!el) throw new Error(`no streaming element rendered for ${id}`);
    return el;
  }

  describe('inline patterns', () => {
    test('bold via ** and __', async () => {
      const el = await renderAssistant('A **strong** word and __also strong__.');
      const strongs = el.querySelectorAll('strong');
      expect(strongs.length).toBe(2);
      expect(strongs[0].textContent).toBe('strong');
      expect(strongs[1].textContent).toBe('also strong');
    });

    test('italic via * and _', async () => {
      const el = await renderAssistant('Some *italic* and _also italic_ words.');
      const ems = el.querySelectorAll('em');
      expect(ems.length).toBe(2);
      expect(ems[0].textContent).toBe('italic');
      expect(ems[1].textContent).toBe('also italic');
    });

    test('inline code', async () => {
      const el = await renderAssistant('Run `npm install` to start.');
      expect(el.querySelector('code')?.textContent).toBe('npm install');
    });

    test('mailto link', async () => {
      const el = await renderAssistant(
        'Email us at [support@example.com](mailto:support@example.com).',
      );
      const link = el.querySelector<HTMLAnchorElement>('a');
      expect(link?.getAttribute('href')).toBe('mailto:support@example.com');
      expect(link?.textContent).toBe('support@example.com');
    });

    test('image markdown', async () => {
      const el = await renderAssistant('![logo](https://example.com/logo.png)');
      const img = el.querySelector<HTMLImageElement>('img');
      expect(img?.getAttribute('src')).toBe('https://example.com/logo.png');
      expect(img?.getAttribute('alt')).toBe('logo');
    });

    test('multiple inline patterns in one paragraph', async () => {
      const el = await renderAssistant(
        'See **bold**, *italic*, `code`, and [link](https://example.com) together.',
      );
      expect(el.querySelector('strong')?.textContent).toBe('bold');
      expect(el.querySelector('em')?.textContent).toBe('italic');
      expect(el.querySelector('code')?.textContent).toBe('code');
      expect(el.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe(
        'https://example.com',
      );
    });

    test('multiple links in same paragraph', async () => {
      const el = await renderAssistant(
        'Visit [Site A](https://a.example.com) or [Site B](https://b.example.com).',
      );
      const links = el.querySelectorAll<HTMLAnchorElement>('a');
      expect(links.length).toBe(2);
      expect(links[0].getAttribute('href')).toBe('https://a.example.com');
      expect(links[1].getAttribute('href')).toBe('https://b.example.com');
    });

    test('link target/rel hardened to open safely', async () => {
      const el = await renderAssistant('[Go](https://example.com)');
      const link = el.querySelector<HTMLAnchorElement>('a');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toContain('noopener');
    });
  });

  describe('block patterns', () => {
    test('all heading levels h1-h6', async () => {
      const md = ['# H1', '## H2', '### H3', '#### H4', '##### H5', '###### H6'].join('\n\n');
      const el = await renderAssistant(md);
      for (let level = 1; level <= 6; level += 1) {
        expect(el.querySelector(`h${level}`)?.textContent).toBe(`H${level}`);
      }
    });

    test('fenced code block preserves whitespace', async () => {
      const el = await renderAssistant('```\nline 1\n  line 2\nline 3\n```');
      const code = el.querySelector('pre code');
      expect(code).not.toBeNull();
      expect(code?.textContent).toBe('line 1\n  line 2\nline 3\n');
    });

    test('fenced code block with language preserves content', async () => {
      // The renderer emits `class="language-js"`, but the DOMPurify allowlist
      // only keeps `class` on <a>, so we just assert the body survives.
      const el = await renderAssistant('```js\nconst x = 1;\n```');
      expect(el.querySelector('pre code')?.textContent).toContain('const x = 1;');
    });

    test('blockquote', async () => {
      const el = await renderAssistant('> Important reminder.\n> Stay safe.');
      const bq = el.querySelector('blockquote');
      expect(bq).not.toBeNull();
      expect(bq?.textContent).toContain('Important reminder');
      expect(bq?.textContent).toContain('Stay safe');
    });

    test('horizontal rule', async () => {
      const el = await renderAssistant('Above\n\n---\n\nBelow');
      expect(el.querySelector('hr')).not.toBeNull();
      const paragraphs = el.querySelectorAll('p');
      expect(paragraphs.length).toBe(2);
    });

    test('GFM table', async () => {
      const md = ['| Col A | Col B |', '| --- | --- |', '| a1 | b1 |', '| a2 | b2 |'].join('\n');
      const el = await renderAssistant(md);
      const table = el.querySelector('table');
      expect(table).not.toBeNull();
      expect(table?.querySelectorAll('th').length).toBe(2);
      expect(table?.querySelectorAll('tbody tr').length).toBe(2);
    });

    test('ordered list with both . and )', async () => {
      const dotList = await renderAssistant('1. one\n2. two\n3. three');
      expect(dotList.querySelector('ol')).not.toBeNull();
      expect(dotList.querySelectorAll('ol > li').length).toBe(3);

      const parenList = await renderAssistant('1) first\n2) second');
      expect(parenList.querySelector('ol')).not.toBeNull();
      expect(parenList.querySelectorAll('ol > li').length).toBe(2);
    });

    test('unordered list with * and -', async () => {
      const starList = await renderAssistant('* alpha\n* beta');
      expect(starList.querySelectorAll('ul > li').length).toBe(2);

      const dashList = await renderAssistant('- alpha\n- beta');
      expect(dashList.querySelectorAll('ul > li').length).toBe(2);
    });
  });

  describe('nested patterns', () => {
    test('nested unordered list (two levels)', async () => {
      const el = await renderAssistant(
        ['* parent A', '  * child A1', '  * child A2', '* parent B'].join('\n'),
      );
      const outer = el.querySelector('ul');
      expect(outer).not.toBeNull();
      const outerItems = outer?.querySelectorAll(':scope > li') ?? [];
      expect(outerItems.length).toBe(2);
      const inner = outerItems[0]?.querySelector('ul');
      expect(inner).not.toBeNull();
      expect(inner?.querySelectorAll('li').length).toBe(2);
    });

    test('nested ordered list (two levels)', async () => {
      const el = await renderAssistant(
        ['1. step one', '   1. detail a', '   2. detail b', '2. step two'].join('\n'),
      );
      const outer = el.querySelector('ol');
      expect(outer).not.toBeNull();
      const outerItems = outer?.querySelectorAll(':scope > li') ?? [];
      expect(outerItems.length).toBe(2);
      const inner = outerItems[0]?.querySelector('ol');
      expect(inner).not.toBeNull();
      expect(inner?.querySelectorAll('li').length).toBe(2);
    });

    test('bold inside list item', async () => {
      const el = await renderAssistant('* a **bolded** word\n* normal word');
      const firstItem = el.querySelector('li');
      expect(firstItem?.querySelector('strong')?.textContent).toBe('bolded');
    });

    test('link inside list item', async () => {
      const el = await renderAssistant(
        '* visit [docs](https://docs.example.com)\n* see also [home](https://example.com)',
      );
      const links = el.querySelectorAll<HTMLAnchorElement>('li a');
      expect(links.length).toBe(2);
      expect(links[0].getAttribute('href')).toBe('https://docs.example.com');
      expect(links[1].getAttribute('href')).toBe('https://example.com');
    });

    test('multiple inline patterns inside a single list item', async () => {
      const el = await renderAssistant(
        '* **bold** and *italic* and `code` and [link](https://example.com)',
      );
      const li = el.querySelector('li');
      expect(li?.querySelector('strong')).not.toBeNull();
      expect(li?.querySelector('em')).not.toBeNull();
      expect(li?.querySelector('code')).not.toBeNull();
      expect(li?.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    });

    test('inline patterns inside a heading', async () => {
      const el = await renderAssistant('## A **bold** and `coded` heading');
      const h2 = el.querySelector('h2');
      expect(h2?.querySelector('strong')?.textContent).toBe('bold');
      expect(h2?.querySelector('code')?.textContent).toBe('coded');
    });

    test('inline patterns inside a blockquote', async () => {
      const el = await renderAssistant('> Visit [example](https://example.com) for **more**.');
      const bq = el.querySelector('blockquote');
      expect(bq?.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe(
        'https://example.com',
      );
      expect(bq?.querySelector('strong')?.textContent).toBe('more');
    });
  });

  describe('streaming chunk splits', () => {
    test('bold spanning two chunks renders as <strong>', async () => {
      const el = await streamChunks(['Hello **wor', 'ld** today.']);
      expect(el.querySelector('strong')?.textContent).toBe('world');
    });

    test('link split across chunks renders as clickable <a>', async () => {
      const el = await streamChunks(['Click [the link](htt', 'ps://example.com) here.']);
      const link = el.querySelector<HTMLAnchorElement>('a');
      expect(link?.getAttribute('href')).toBe('https://example.com');
      expect(link?.textContent).toBe('the link');
    });

    test('list items arriving as separate chunks coalesce into one <ul>', async () => {
      const el = await streamChunks(['* one\n', '* two\n', '* three\n']);
      const items = el.querySelectorAll('ul > li');
      expect(items.length).toBe(3);
      expect(items[0].textContent).toBe('one');
      expect(items[2].textContent).toBe('three');
    });

    test('paragraph break inside chunk creates two paragraphs', async () => {
      const el = await streamChunks(['First paragraph.', '\n\n', 'Second paragraph.']);
      expect(el.querySelectorAll('p').length).toBe(2);
    });

    test('many small chunks accumulate to final correct DOM', async () => {
      const text = 'A list:\n\n* alpha\n* beta\n* gamma';
      const el = await streamChunks(text.split(''));
      expect(el.querySelectorAll('ul > li').length).toBe(3);
      expect(el.querySelector('p')?.textContent).toBe('A list:');
    });
  });

  describe('regression edge cases', () => {
    // NOTE: underscores-inside-URLs (file_name.pdf → file<em>name</em>.pdf)
    // is a separate renderer bug tracked by ABLP-1200/ABLP-1154. The fix
    // (commit d3360729b9, tokenize bare URLs + HTML tags before applying
    // emphasis) hasn't merged to develop yet, so we don't assert it here.
    // ABLP-1189 only ports the markdown-rendering branch into UnifiedWidget.

    test('query-string URLs with & survive HTML escape round trip', async () => {
      const el = await renderAssistant('[Search](https://example.com/q?foo=1&bar=2&baz=3)');
      const link = el.querySelector<HTMLAnchorElement>('a');
      expect(link).not.toBeNull();
      // The href must be a valid URL with the same parameters reaching the browser.
      const href = link?.getAttribute('href') ?? '';
      const url = new URL(href, 'https://example.com');
      expect(url.searchParams.get('foo')).toBe('1');
      expect(url.searchParams.get('bar')).toBe('2');
      expect(url.searchParams.get('baz')).toBe('3');
    });

    test('raw HTML in content is escaped, not executed', async () => {
      const el = await renderAssistant('<script>alert(1)</script> <b>not bold</b>');
      expect(el.querySelector('script')).toBeNull();
      expect(el.querySelector('b')).toBeNull();
      expect(el.textContent).toContain('<script>');
      expect(el.textContent).toContain('<b>not bold</b>');
    });

    test('javascript: URLs are stripped from links', async () => {
      const el = await renderAssistant('[Bad](javascript:alert(1))');
      const link = el.querySelector<HTMLAnchorElement>('a');
      // Label stays as visible text but href must not carry the unsafe scheme.
      expect(link?.getAttribute('href')).not.toBe('javascript:alert(1)');
    });

    test('plain prose with no markdown still renders as paragraph', async () => {
      const el = await renderAssistant('Just a plain sentence with no formatting.');
      expect(el.querySelector('p')?.textContent).toBe('Just a plain sentence with no formatting.');
    });

    test('empty content falls through to text path without crashing', async () => {
      // hasRichContent is false and content is empty → else branch runs.
      const el = await renderAssistant('');
      expect(el).not.toBeNull();
      expect(el.querySelector('a')).toBeNull();
    });

    test('whitespace-only content does not produce orphan paragraphs', async () => {
      const el = await renderAssistant('   \n\n  \n');
      expect(el.querySelector('p')).toBeNull();
    });

    test('mixed message: heading + paragraph + list + table in one response', async () => {
      const md = [
        '# Report',
        '',
        'Summary of activity:',
        '',
        '* total: 42',
        '* failed: 1',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Revenue | $42 |',
      ].join('\n');
      const el = await renderAssistant(md);
      expect(el.querySelector('h1')?.textContent).toBe('Report');
      expect(el.querySelector('p')?.textContent).toBe('Summary of activity:');
      expect(el.querySelectorAll('ul > li').length).toBe(2);
      expect(el.querySelector('table')).not.toBeNull();
    });
  });
});
