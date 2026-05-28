import { describe, it, expect } from 'vitest';
import type { Message, RichContent } from '../core/types.js';
import { defaultRegistry } from '../templates/registry.js';
import type { TemplateContext } from '../templates/types.js';

// Trigger renderer registration
import '../templates/index.js';

function makeMessage(rc: Partial<RichContent>): Message {
  return {
    id: 'msg-safe',
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    richContent: rc as RichContent,
  };
}

const ctx: TemplateContext = {
  theme: {},
  messageId: 'msg-safe',
  onAction: () => {},
};

function renderAndFind(msg: Message, type: string): HTMLElement {
  const matches = defaultRegistry.match(msg);
  const match = matches.find((m) => m.renderer.type === type);
  expect(match).toBeDefined();
  return match!.renderer.renderDOM(match!.data, ctx);
}

describe('isSafeUrl integration across renderers', () => {
  const unsafeUrls = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>'];
  const safeUrls = ['https://example.com/file.png', 'http://example.com/file.pdf'];

  describe('image renderer', () => {
    it.each(unsafeUrls)('blocks unsafe URL: %s', (url) => {
      const el = renderAndFind(makeMessage({ image: { url } }), 'image');
      expect(el.querySelector('img')).toBeNull();
    });

    it.each(safeUrls)('allows safe URL: %s', (url) => {
      const el = renderAndFind(makeMessage({ image: { url, alt: 'test' } }), 'image');
      const img = el.querySelector('img');
      expect(img).toBeTruthy();
      expect(img!.src).toContain(url);
    });
  });

  describe('video renderer', () => {
    it.each(unsafeUrls)('blocks unsafe URL: %s', (url) => {
      const el = renderAndFind(makeMessage({ video: { url } }), 'video');
      const video = el.querySelector('video');
      // Should either not render or not have src
      if (video) {
        expect(video.querySelector('source')?.src || '').not.toContain('javascript:');
      }
    });

    it.each(safeUrls)('allows safe URL: %s', (url) => {
      const el = renderAndFind(makeMessage({ video: { url } }), 'video');
      expect(el.querySelector('video')).toBeTruthy();
    });
  });

  describe('audio renderer', () => {
    it.each(unsafeUrls)('blocks unsafe URL: %s', (url) => {
      const el = renderAndFind(makeMessage({ audio: { url } }), 'audio');
      const audio = el.querySelector('audio');
      if (audio) {
        expect(audio.querySelector('source')?.src || '').not.toContain('javascript:');
      }
    });

    it.each(safeUrls)('allows safe URL: %s', (url) => {
      const el = renderAndFind(makeMessage({ audio: { url } }), 'audio');
      expect(el.querySelector('audio')).toBeTruthy();
    });
  });

  describe('file renderer', () => {
    it.each(unsafeUrls)('blocks unsafe URL: %s', (url) => {
      const el = renderAndFind(makeMessage({ file: { url, filename: 'bad.txt' } }), 'file');
      const link = el.querySelector('a');
      expect(link).toBeNull();
    });

    it.each(safeUrls)('allows safe URL: %s', (url) => {
      const el = renderAndFind(makeMessage({ file: { url, filename: 'good.txt' } }), 'file');
      const link = el.querySelector('a');
      expect(link).toBeTruthy();
    });
  });

  describe('list renderer', () => {
    it('blocks unsafe image_url in list items', () => {
      const el = renderAndFind(
        makeMessage({
          list: {
            items: [{ title: 'Item', image_url: 'javascript:alert(1)' }],
          },
        }),
        'list',
      );
      expect(el.querySelector('img')).toBeNull();
    });

    it('allows safe image_url in list items', () => {
      const el = renderAndFind(
        makeMessage({
          list: {
            items: [{ title: 'Item', image_url: 'https://example.com/img.png' }],
          },
        }),
        'list',
      );
      expect(el.querySelector('img')).toBeTruthy();
    });
  });

  describe('quick_replies renderer', () => {
    it('blocks unsafe icon_url', () => {
      const el = renderAndFind(
        makeMessage({
          quick_replies: [{ id: '1', label: 'Bad', icon_url: 'javascript:alert(1)' }],
        }),
        'quick_replies',
      );
      expect(el.querySelector('img')).toBeNull();
    });

    it('allows safe icon_url', () => {
      const el = renderAndFind(
        makeMessage({
          quick_replies: [{ id: '1', label: 'Good', icon_url: 'https://example.com/icon.png' }],
        }),
        'quick_replies',
      );
      expect(el.querySelector('img')).toBeTruthy();
    });
  });

  describe('kpi renderer', () => {
    it('blocks unsafe icon_url', () => {
      const el = renderAndFind(
        makeMessage({
          kpi: { label: 'X', value: 1, icon_url: 'javascript:alert(1)' },
        }),
        'kpi',
      );
      expect(el.querySelector('img')).toBeNull();
    });

    it('allows safe icon_url', () => {
      const el = renderAndFind(
        makeMessage({
          kpi: { label: 'X', value: 1, icon_url: 'https://example.com/icon.png' },
        }),
        'kpi',
      );
      expect(el.querySelector('img')).toBeTruthy();
    });
  });
});
