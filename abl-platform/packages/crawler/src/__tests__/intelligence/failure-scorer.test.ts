import { describe, it, expect } from 'vitest';
import { FailureScorer } from '../../intelligence/algorithms/failure-scorer.js';
import { createCrawlResult } from '../../intelligence/algorithms/types.js';

describe('FailureScorer', () => {
  const scorer = new FailureScorer();

  // ─── Positive Signal Tests ──────────────────────────────────────

  describe('short_text signal', () => {
    it('detects text shorter than 200 characters', () => {
      const result = createCrawlResult({
        text: 'Short content',
        html: '<html><body>Short content</body></html>',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'short_text');
      expect(signal?.detected).toBe(true);
      expect(signal?.weight).toBe(25);
      expect(signal?.value).toBe(13);
    });

    it('does not trigger for text >= 200 characters', () => {
      const longText = 'A'.repeat(200);
      const result = createCrawlResult({ text: longText });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'short_text');
      expect(signal?.detected).toBe(false);
    });
  });

  describe('no_links signal', () => {
    it('detects pages with zero links', () => {
      const result = createCrawlResult({ links: [] });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'no_links');
      expect(signal?.detected).toBe(true);
      expect(signal?.weight).toBe(15);
    });

    it('does not trigger when links are present', () => {
      const result = createCrawlResult({
        links: [{ text: 'Home', href: '/' }],
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'no_links');
      expect(signal?.detected).toBe(false);
    });
  });

  describe('empty_mount_point signal', () => {
    it('detects empty React root div', () => {
      const result = createCrawlResult({
        html: '<html><body><div id="root"></div></body></html>',
        text: '',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'empty_mount_point');
      expect(signal?.detected).toBe(true);
      expect(signal?.weight).toBe(30);
    });

    it('detects empty Vue app div', () => {
      const result = createCrawlResult({
        html: '<html><body><div id="app"></div></body></html>',
        text: '',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'empty_mount_point');
      expect(signal?.detected).toBe(true);
    });

    it('detects empty Next.js __next div', () => {
      const result = createCrawlResult({
        html: '<html><body><div id="__next"></div></body></html>',
        text: '',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'empty_mount_point');
      expect(signal?.detected).toBe(true);
    });

    it('does not trigger when mount point has content', () => {
      const content = 'A'.repeat(60);
      const result = createCrawlResult({
        html: `<html><body><div id="root">${content}</div></body></html>`,
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'empty_mount_point');
      expect(signal?.detected).toBe(false);
    });

    it('does not trigger when no mount point exists', () => {
      const result = createCrawlResult({
        html: '<html><body><div>Regular content</div></body></html>',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'empty_mount_point');
      expect(signal?.detected).toBe(false);
    });
  });

  describe('high_markup_ratio signal', () => {
    it('detects when HTML is 50x+ larger than text', () => {
      const text = 'Small text';
      // 10 chars of text, need html > 500 chars
      const html = '<html>' + '<script>'.repeat(100) + '</html>';
      const result = createCrawlResult({ html, text });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'high_markup_ratio');
      expect(signal?.detected).toBe(true);
      expect(signal?.weight).toBe(15);
    });

    it('does not trigger for normal content pages', () => {
      const text = 'A'.repeat(200);
      const html = `<html><body>${text}</body></html>`;
      const result = createCrawlResult({ html, text });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'high_markup_ratio');
      expect(signal?.detected).toBe(false);
    });
  });

  describe('noscript_content signal', () => {
    it('detects noscript with meaningful text', () => {
      const noscriptText =
        'This application requires JavaScript to run. Please enable JavaScript in your browser settings.';
      const result = createCrawlResult({
        html: `<html><body><noscript>${noscriptText}</noscript></body></html>`,
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'noscript_content');
      expect(signal?.detected).toBe(true);
      expect(signal?.weight).toBe(10);
    });

    it('does not trigger for short noscript text', () => {
      const result = createCrawlResult({
        html: '<html><body><noscript>Enable JS</noscript></body></html>',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'noscript_content');
      expect(signal?.detected).toBe(false);
    });

    it('strips HTML tags inside noscript before measuring', () => {
      // Inner HTML tags should not count toward the 50-char threshold
      const result = createCrawlResult({
        html: '<html><body><noscript><div><p>JS</p></div></noscript></body></html>',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'noscript_content');
      expect(signal?.detected).toBe(false);
    });
  });

  describe('framework_marker signal', () => {
    it('detects __NEXT_DATA__', () => {
      const result = createCrawlResult({
        html: '<html><script id="__NEXT_DATA__" type="application/json">{}</script></html>',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'framework_marker');
      expect(signal?.detected).toBe(true);
      expect(signal?.weight).toBe(10);
    });

    it('detects __NUXT__', () => {
      const result = createCrawlResult({
        html: '<html><script>window.__NUXT__={}</script></html>',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'framework_marker');
      expect(signal?.detected).toBe(true);
    });

    it('detects __GATSBY', () => {
      const result = createCrawlResult({
        html: '<html><div id="__GATSBY"></div></html>',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'framework_marker');
      expect(signal?.detected).toBe(true);
    });

    it('does not trigger for plain HTML pages', () => {
      const result = createCrawlResult({
        html: '<html><body><p>Plain page</p></body></html>',
      });
      const score = scorer.score(result);
      const signal = score.signals.find((s) => s.name === 'framework_marker');
      expect(signal?.detected).toBe(false);
    });
  });

  // ─── Anti-Signal Tests ──────────────────────────────────────────

  describe('ssr_next_data anti-signal', () => {
    it('detects Next.js SSR with substantial text', () => {
      const longText = 'A'.repeat(600);
      const result = createCrawlResult({
        html: `<html><script id="__NEXT_DATA__">{}</script><body>${longText}</body></html>`,
        text: longText,
      });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'ssr_next_data');
      expect(antiSignal?.detected).toBe(true);
      expect(antiSignal?.weight).toBe(-20);
    });

    it('does not trigger without __NEXT_DATA__', () => {
      const longText = 'A'.repeat(600);
      const result = createCrawlResult({
        html: `<html><body>${longText}</body></html>`,
        text: longText,
      });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'ssr_next_data');
      expect(antiSignal?.detected).toBe(false);
    });

    it('does not trigger with __NEXT_DATA__ but short text', () => {
      const result = createCrawlResult({
        html: '<html><script id="__NEXT_DATA__">{}</script></html>',
        text: 'Short',
      });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'ssr_next_data');
      expect(antiSignal?.detected).toBe(false);
    });
  });

  describe('ssr_content_rich anti-signal', () => {
    it('detects content-rich pages', () => {
      const longText = 'A'.repeat(1100);
      const links = Array.from({ length: 10 }, (_, i) => ({
        text: `Link ${i}`,
        href: `/${i}`,
      }));
      const result = createCrawlResult({ text: longText, links });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'ssr_content_rich');
      expect(antiSignal?.detected).toBe(true);
      expect(antiSignal?.weight).toBe(-15);
    });

    it('does not trigger with short text even with many links', () => {
      const links = Array.from({ length: 10 }, (_, i) => ({
        text: `Link ${i}`,
        href: `/${i}`,
      }));
      const result = createCrawlResult({ text: 'Short', links });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'ssr_content_rich');
      expect(antiSignal?.detected).toBe(false);
    });
  });

  describe('structured_data anti-signal', () => {
    it('detects JSON-LD structured data', () => {
      const result = createCrawlResult({
        html: '<html><head><script type="application/ld+json">{"@type":"WebPage"}</script></head></html>',
      });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'structured_data');
      expect(antiSignal?.detected).toBe(true);
      expect(antiSignal?.weight).toBe(-10);
    });

    it('does not trigger without JSON-LD', () => {
      const result = createCrawlResult({
        html: '<html><body><p>No structured data</p></body></html>',
      });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'structured_data');
      expect(antiSignal?.detected).toBe(false);
    });
  });

  describe('meta_generator anti-signal', () => {
    it('detects known framework in generator meta', () => {
      const result = createCrawlResult({
        html: '<html><head><meta name="generator" content="Next.js"></head></html>',
      });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'meta_generator');
      expect(antiSignal?.detected).toBe(true);
      expect(antiSignal?.weight).toBe(-10);
    });

    it('detects Hugo in generator meta', () => {
      const result = createCrawlResult({
        html: '<html><head><meta name="generator" content="Hugo 0.123.0"></head></html>',
      });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'meta_generator');
      expect(antiSignal?.detected).toBe(true);
    });

    it('does not trigger for unknown generator', () => {
      const result = createCrawlResult({
        html: '<html><head><meta name="generator" content="MyCustomCMS 1.0"></head></html>',
      });
      const score = scorer.score(result);
      const antiSignal = score.positiveSignals.find((s) => s.name === 'meta_generator');
      expect(antiSignal?.detected).toBe(false);
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty HTML without crashing', () => {
      const result = createCrawlResult({ html: '', text: '' });
      const score = scorer.score(result);
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(100);
      expect(typeof score.shouldEscalate).toBe('boolean');
    });

    it('handles malformed HTML without crashing', () => {
      const result = createCrawlResult({
        html: '<<<>>>not<valid><<<<html>>>>>',
        text: 'some text',
      });
      const score = scorer.score(result);
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(100);
    });

    it('handles huge HTML (>1MB) without crashing', () => {
      const hugeHtml = '<div>' + 'x'.repeat(1_100_000) + '</div>';
      const result = createCrawlResult({
        html: hugeHtml,
        text: 'x'.repeat(1_100_000),
      });
      const score = scorer.score(result);
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(100);
    });

    it('handles missing fields gracefully (undefined text/links)', () => {
      const result = createCrawlResult({});
      // Override to simulate missing fields from Go
      const incomplete = {
        ...result,
        text: undefined as unknown as string,
        links: undefined as unknown as [],
        html: undefined as unknown as string,
      };
      const score = scorer.score(incomplete);
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(100);
    });

    it('clamps score to 0 when anti-signals dominate', () => {
      // All anti-signals, no positive signals = negative raw score clamped to 0
      const longText = 'A'.repeat(1200);
      const links = Array.from({ length: 10 }, (_, i) => ({
        text: `Link ${i}`,
        href: `/${i}`,
      }));
      const result = createCrawlResult({
        html: `<html><head>
          <script id="__NEXT_DATA__">{}</script>
          <script type="application/ld+json">{"@type":"WebPage"}</script>
          <meta name="generator" content="Next.js">
        </head><body>${longText}</body></html>`,
        text: longText,
        links,
      });
      const score = scorer.score(result);
      expect(score.score).toBe(0);
      expect(score.shouldEscalate).toBe(false);
    });

    it('clamps score to 100 when many positive signals trigger', () => {
      // All positive signals at once: 25 + 15 + 30 + 15 + 10 + 10 = 105 → clamped to 100
      const result = createCrawlResult({
        html:
          '<html><body>' +
          '<div id="root"></div>' +
          '<noscript>This application requires JavaScript to be enabled. Please enable JavaScript in your browser.</noscript>' +
          '<script>window.__NEXT_DATA__={}</script>' +
          '<script>' +
          'x'.repeat(10000) +
          '</script>' +
          '</body></html>',
        text: '',
        links: [],
      });
      const score = scorer.score(result);
      expect(score.score).toBe(100);
      expect(score.shouldEscalate).toBe(true);
    });
  });

  // ─── Combined Signal Tests ──────────────────────────────────────

  describe('combined signals', () => {
    it('SPA page: short_text + empty_mount_point + no_links = high score', () => {
      const result = createCrawlResult({
        html: '<html><body><div id="root"></div></body></html>',
        text: '',
        links: [],
      });
      const score = scorer.score(result);
      // short_text (25) + no_links (15) + empty_mount_point (30) + high_markup_ratio (15) = 85
      expect(score.score).toBeGreaterThanOrEqual(70);
      expect(score.shouldEscalate).toBe(true);
    });

    it('SSR Next.js: __NEXT_DATA__ with rich content = low score', () => {
      const longText = 'A'.repeat(1200);
      const links = Array.from({ length: 10 }, (_, i) => ({
        text: `Link ${i}`,
        href: `/${i}`,
      }));
      const result = createCrawlResult({
        html: `<html>
          <script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
          <body><div id="__next">${longText}</div></body>
        </html>`,
        text: longText,
        links,
      });
      const score = scorer.score(result);
      // framework_marker (+10) offset by ssr_next_data (-20) + ssr_content_rich (-15)
      expect(score.score).toBeLessThan(50);
      expect(score.shouldEscalate).toBe(false);
    });

    it('static HTML page with rich content = zero escalation signals', () => {
      const text = 'A'.repeat(500);
      const links = Array.from({ length: 8 }, (_, i) => ({
        text: `Link ${i}`,
        href: `/${i}`,
      }));
      const result = createCrawlResult({
        html: `<html><head><title>Static Page</title></head><body><h1>Title</h1><p>${text}</p></body></html>`,
        text: `Title ${text}`,
        links,
      });
      const score = scorer.score(result);
      expect(score.score).toBe(0);
      expect(score.shouldEscalate).toBe(false);
    });
  });

  // ─── Batch Scoring ──────────────────────────────────────────────

  describe('scoreBatch', () => {
    it('returns per-URL results with aggregate stats', () => {
      const spaPage = createCrawlResult({
        url: 'https://spa.example.com',
        html: '<html><body><div id="root"></div></body></html>',
        text: '',
        links: [],
      });
      const staticPage = createCrawlResult({
        url: 'https://static.example.com',
        html: `<html><body><p>${'A'.repeat(500)}</p></body></html>`,
        text: 'A'.repeat(500),
        links: Array.from({ length: 8 }, (_, i) => ({
          text: `Link ${i}`,
          href: `/${i}`,
        })),
      });

      const batch = scorer.scoreBatch([spaPage, staticPage]);

      expect(batch.results).toHaveLength(2);
      expect(batch.results[0].url).toBe('https://spa.example.com');
      expect(batch.results[0].score.shouldEscalate).toBe(true);
      expect(batch.results[1].url).toBe('https://static.example.com');
      expect(batch.results[1].score.shouldEscalate).toBe(false);

      expect(batch.stats.total).toBe(2);
      expect(batch.stats.escalated).toBe(1);
      expect(batch.stats.escalationRate).toBe(0.5);
    });

    it('handles empty batch', () => {
      const batch = scorer.scoreBatch([]);
      expect(batch.results).toHaveLength(0);
      expect(batch.stats.total).toBe(0);
      expect(batch.stats.escalated).toBe(0);
      expect(batch.stats.escalationRate).toBe(0);
    });
  });

  // ─── Config Override Tests ──────────────────────────────────────

  describe('config overrides', () => {
    it('respects custom escalation threshold', () => {
      const lowThreshold = new FailureScorer({ escalationThreshold: 10 });
      const highThreshold = new FailureScorer({ escalationThreshold: 90 });

      // A page with just short_text (25 points)
      const result = createCrawlResult({
        text: 'Short',
        html: `<html><body>Short</body></html>`,
        links: [{ text: 'Link', href: '/' }],
      });

      const lowScore = lowThreshold.score(result);
      const highScore = highThreshold.score(result);

      expect(lowScore.shouldEscalate).toBe(true);
      expect(highScore.shouldEscalate).toBe(false);
      // Same score, different escalation decision
      expect(lowScore.score).toBe(highScore.score);
    });

    it('respects custom signal weights', () => {
      const customScorer = new FailureScorer({
        weights: { short_text: 50, no_links: 50 },
      });
      const result = createCrawlResult({
        text: 'Short',
        html: '<html><body>Short</body></html>',
        links: [],
      });
      const score = customScorer.score(result);
      // short_text (50) + no_links (50) + high_markup_ratio (15) = 115 → clamped to 100
      expect(score.score).toBe(100);
    });

    it('allows overriding anti-signal weights', () => {
      const customScorer = new FailureScorer({
        weights: { ssr_next_data: -50 },
      });
      const longText = 'A'.repeat(600);
      const result = createCrawlResult({
        html: `<html><script id="__NEXT_DATA__">{}</script><body>${longText}</body></html>`,
        text: longText,
        links: [{ text: 'Link', href: '/' }],
      });
      const score = customScorer.score(result);
      // framework_marker (+10) + ssr_next_data (-50) = negative → clamped to 0
      expect(score.score).toBe(0);
    });
  });

  // ─── Reason String Tests ────────────────────────────────────────

  describe('reason string', () => {
    it('provides a meaningful reason for escalation', () => {
      const result = createCrawlResult({
        html: '<html><body><div id="root"></div></body></html>',
        text: '',
        links: [],
      });
      const score = scorer.score(result);
      expect(score.reason).toContain('Score');
      expect(score.reason).toContain('Failure signals');
      expect(score.reason).toContain('escalation');
    });

    it('provides a meaningful reason for no escalation', () => {
      const text = 'A'.repeat(500);
      const result = createCrawlResult({
        html: `<html><body>${text}</body></html>`,
        text,
        links: Array.from({ length: 3 }, (_, i) => ({
          text: `L${i}`,
          href: `/${i}`,
        })),
      });
      const score = scorer.score(result);
      expect(score.reason).toContain('No failure signals');
    });
  });
});
