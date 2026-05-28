import { describe, it, expect, beforeEach } from 'vitest';
import type { Message, RichContent, ActionSet } from '../core/types.js';
import { defaultRegistry } from '../templates/registry.js';
import type { TemplateContext } from '../templates/types.js';

// Trigger renderer registration
import '../templates/index.js';

function makeMessage(rc?: Partial<RichContent>, actions?: ActionSet): Message {
  return {
    id: 'msg-test',
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    richContent: rc as RichContent,
    actions,
  };
}

function makeCtx(): TemplateContext {
  return {
    theme: {},
    messageId: 'msg-test',
    onAction: () => {},
  };
}

// =============================================================================
// Type Shape Assertions (satisfies)
// =============================================================================

describe('Type shapes', () => {
  it('RichContent accepts all 12 new template fields', () => {
    const rc: RichContent = {
      markdown: 'hello',
      quick_replies: [{ id: '1', label: 'Yes' }],
      list: { items: [{ title: 'Item 1' }] },
      image: { url: 'https://example.com/img.png' },
      video: { url: 'https://example.com/vid.mp4' },
      audio: { url: 'https://example.com/audio.mp3' },
      file: { url: 'https://example.com/doc.pdf', filename: 'doc.pdf' },
      kpi: { label: 'Revenue', value: 42000 },
      table: { columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] },
      chart: { type: 'bar', data: [{ label: 'Q1', value: 100 }] },
      form: { fields: [{ id: 'f1', type: 'input', label: 'Name' }] },
      progress: { value: 75 },
      feedback: { prompt: 'Rate this', type: 'stars' },
    };
    expect(rc.quick_replies).toHaveLength(1);
    expect(rc.kpi?.label).toBe('Revenue');
  });
});

// =============================================================================
// Renderer DOM Output Tests
// =============================================================================

describe('Renderer DOM output', () => {
  const ctx = makeCtx();

  it('markdown renderer produces sanitized HTML', () => {
    const msg = makeMessage({ markdown: '**bold text**' });
    const matches = defaultRegistry.match(msg);
    const mdMatch = matches.find((m) => m.renderer.type === 'markdown');
    expect(mdMatch).toBeDefined();
    const el = mdMatch!.renderer.renderDOM(mdMatch!.data, ctx);
    expect(el.className).toBe('rich-text');
    expect(el.innerHTML).toContain('<strong>');
  });

  it('markdown renderer parses markdown tables', () => {
    const msg = makeMessage({
      markdown: '| Name | Balance |\n| --- | --- |\n| Alice | $10 |\n| Bob | $20 |',
    });
    const matches = defaultRegistry.match(msg);
    const mdMatch = matches.find((m) => m.renderer.type === 'markdown');
    expect(mdMatch).toBeDefined();
    const el = mdMatch!.renderer.renderDOM(mdMatch!.data, ctx);
    expect(el.querySelector('table')).toBeTruthy();
    expect(el.querySelectorAll('th')).toHaveLength(2);
    expect(el.innerHTML).toContain('<td>Bob</td>');
  });

  it('channel fallback renderer surfaces unsupported channel payloads', () => {
    const msg = makeMessage({
      slack:
        '{"text":"Hello from Slack","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*Hello* from Slack"}}]}',
    });
    const matches = defaultRegistry.match(msg);
    const fallbackMatch = matches.find((m) => m.renderer.type === 'channel_fallback');
    expect(fallbackMatch).toBeDefined();
    const el = fallbackMatch!.renderer.renderDOM(fallbackMatch!.data, ctx);
    expect(el.textContent).toContain('Slack Block Kit');
    expect(el.textContent).toContain('Hello from Slack');
  });

  it('carousel renderer produces card elements', () => {
    const msg = makeMessage({
      carousel: {
        cards: [{ title: 'Card 1', image_url: 'https://example.com/img.png' }, { title: 'Card 2' }],
      },
    });
    const matches = defaultRegistry.match(msg);
    const carMatch = matches.find((m) => m.renderer.type === 'carousel');
    expect(carMatch).toBeDefined();
    const el = carMatch!.renderer.renderDOM(carMatch!.data, ctx);
    expect(el.className).toBe('rich-carousel');
    expect(el.querySelectorAll('.rich-carousel-card').length).toBe(2);
  });

  it('image renderer produces img element with isSafeUrl check', () => {
    const msg = makeMessage({ image: { url: 'https://example.com/photo.jpg', alt: 'Photo' } });
    const matches = defaultRegistry.match(msg);
    const imgMatch = matches.find((m) => m.renderer.type === 'image');
    expect(imgMatch).toBeDefined();
    const el = imgMatch!.renderer.renderDOM(imgMatch!.data, ctx);
    const img = el.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.alt).toBe('Photo');
  });

  it('image renderer rejects javascript: URLs', () => {
    const msg = makeMessage({ image: { url: 'javascript:alert(1)' } });
    const matches = defaultRegistry.match(msg);
    const imgMatch = matches.find((m) => m.renderer.type === 'image');
    expect(imgMatch).toBeDefined();
    const el = imgMatch!.renderer.renderDOM(imgMatch!.data, ctx);
    const img = el.querySelector('img');
    expect(img).toBeNull();
  });

  it('video renderer produces video element', () => {
    const msg = makeMessage({ video: { url: 'https://example.com/vid.mp4', alt: 'Demo' } });
    const matches = defaultRegistry.match(msg);
    const vidMatch = matches.find((m) => m.renderer.type === 'video');
    expect(vidMatch).toBeDefined();
    const el = vidMatch!.renderer.renderDOM(vidMatch!.data, ctx);
    const video = el.querySelector('video');
    expect(video).toBeTruthy();
  });

  it('audio renderer produces audio element', () => {
    const msg = makeMessage({ audio: { url: 'https://example.com/song.mp3' } });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'audio');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.querySelector('audio')).toBeTruthy();
  });

  it('file renderer produces download link', () => {
    const msg = makeMessage({ file: { url: 'https://example.com/doc.pdf', filename: 'doc.pdf' } });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'file');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    const link = el.querySelector('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('download')).toBe('doc.pdf');
  });

  it('list renderer produces list items', () => {
    const msg = makeMessage({
      list: { title: 'My List', items: [{ title: 'Item A' }, { title: 'Item B' }] },
    });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'list');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.className).toBe('rich-list');
  });

  it('kpi renderer shows label and value', () => {
    const msg = makeMessage({ kpi: { label: 'Users', value: 1234, trend: 'up' } });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'kpi');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.className).toBe('rich-kpi');
    expect(el.textContent).toContain('Users');
    expect(el.textContent).toContain('1234');
  });

  it('table renderer produces semantic table', () => {
    const msg = makeMessage({
      table: {
        columns: [{ key: 'name', header: 'Name' }],
        rows: [{ name: 'Alice' }, { name: 'Bob' }],
      },
    });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'table');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.querySelector('table')).toBeTruthy();
    expect(el.querySelectorAll('th').length).toBe(1);
    expect(el.querySelectorAll('td').length).toBeGreaterThanOrEqual(2);
  });

  it('progress renderer uses progressbar role', () => {
    const msg = makeMessage({ progress: { value: 65, max: 100 } });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'progress');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    // role is on the root element, not a child
    expect(el.getAttribute('role')).toBe('progressbar');
    expect(el.getAttribute('aria-valuenow')).toBe('65');
  });

  it('feedback renderer uses radiogroup role', () => {
    const msg = makeMessage({ feedback: { prompt: 'Rate us', type: 'stars', max: 5 } });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'feedback');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.querySelector('[role="radiogroup"]')).toBeTruthy();
  });

  it('quick_replies renderer produces pill buttons', () => {
    const msg = makeMessage({
      quick_replies: [
        { id: 'q1', label: 'Yes' },
        { id: 'q2', label: 'No' },
      ],
    });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'quick_replies');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.getAttribute('role')).toBe('group');
    expect(el.querySelectorAll('button').length).toBe(2);
  });

  it('actions renderer produces button elements', () => {
    const msg = makeMessage(undefined, {
      elements: [{ id: 'btn1', type: 'button', label: 'Click me' }],
    });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'actions');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.querySelector('button')).toBeTruthy();
  });

  it('form renderer produces form with submit', () => {
    const msg = makeMessage({
      form: {
        title: 'Contact',
        fields: [{ id: 'name', type: 'input', label: 'Name' }],
        submit_label: 'Send',
      },
    });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'form');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.className).toBe('rich-form');
  });

  it('chart renderer produces chart container (DOM path)', () => {
    const msg = makeMessage({
      chart: { type: 'bar', data: [{ label: 'A', value: 10 }] },
    });
    const matches = defaultRegistry.match(msg);
    const match = matches.find((m) => m.renderer.type === 'chart');
    expect(match).toBeDefined();
    const el = match!.renderer.renderDOM(match!.data, ctx);
    expect(el.className).toBe('rich-chart');
  });
});

// =============================================================================
// Backwards Compatibility (Task 2.14)
// =============================================================================

describe('Backwards compatibility', () => {
  it('renders messages with only original 3 fields (markdown, carousel, actions)', () => {
    const msg = makeMessage(
      {
        markdown: '# Title',
        carousel: { cards: [{ title: 'Card' }] },
      },
      { elements: [{ id: 'b1', type: 'button', label: 'OK' }] },
    );
    const matches = defaultRegistry.match(msg);
    const types = matches.map((m) => m.renderer.type);
    expect(types).toContain('markdown');
    expect(types).toContain('carousel');
    expect(types).toContain('actions');
  });

  it('message with no richContent returns no matches', () => {
    const msg = makeMessage();
    const matches = defaultRegistry.match(msg);
    expect(matches).toHaveLength(0);
  });
});

// =============================================================================
// Registry Dispatch Integration (Task 2.15)
// =============================================================================

describe('Registry dispatch integration', () => {
  it('matches all 15 renderers for a fully populated message', () => {
    const msg = makeMessage(
      {
        markdown: 'hello',
        carousel: { cards: [{ title: 'C' }] },
        quick_replies: [{ id: '1', label: 'Yes' }],
        list: { items: [{ title: 'I' }] },
        image: { url: 'https://example.com/img.png' },
        video: { url: 'https://example.com/vid.mp4' },
        audio: { url: 'https://example.com/aud.mp3' },
        file: { url: 'https://example.com/f.pdf', filename: 'f.pdf' },
        kpi: { label: 'X', value: 1 },
        table: { columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] },
        chart: { type: 'bar', data: [{ label: 'Q', value: 1 }] },
        form: { fields: [{ id: 'f', type: 'input', label: 'F' }] },
        progress: { value: 50 },
        feedback: { prompt: 'R', type: 'thumbs' },
      },
      { elements: [{ id: 'b', type: 'button', label: 'B' }] },
    );
    const matches = defaultRegistry.match(msg);
    expect(matches.length).toBe(15);

    // Verify registration order matches LLD canonical order
    const types = matches.map((m) => m.renderer.type);
    expect(types).toEqual([
      'markdown',
      'carousel',
      'image',
      'video',
      'audio',
      'file',
      'list',
      'kpi',
      'table',
      'chart',
      'form',
      'progress',
      'feedback',
      'actions',
      'quick_replies',
    ]);
  });
});
