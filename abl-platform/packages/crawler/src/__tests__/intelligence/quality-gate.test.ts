import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { QualityGate } from '../../intelligence/algorithms/quality-gate.js';

describe('QualityGate', () => {
  const gate = new QualityGate();

  // ─── Content Length Signal Tests ─────────────────────────────────

  describe('content_length signal', () => {
    it('AC-1: short content (42 chars) → shouldBlock = true', () => {
      const text = 'A'.repeat(42);
      const html = `<html><body>${text}</body></html>`;
      const result = gate.score(html, text);
      expect(result.shouldBlock).toBe(true);
      expect(result.score).toBeLessThan(0.3);
      expect(result.quality).toBe('thin');
    });

    it('scores zero-length text as thin', () => {
      const result = gate.score('<html><body></body></html>', '');
      expect(result.score).toBeLessThan(0.3);
      expect(result.quality).toBe('thin');
      expect(result.shouldBlock).toBe(true);
      expect(result.contentLength).toBe(0);
    });

    it('content length signal normalizes to 1.0 at 1000+ chars', () => {
      const text = 'A'.repeat(1200);
      const html = `<html><head><title>Page</title></head><body><p>${text}</p></body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'content_length');
      expect(signal?.score).toBe(1);
    });

    it('content length signal scales linearly below 1000 chars', () => {
      const text = 'A'.repeat(500);
      const html = `<html><head><title>Page</title></head><body><p>${text}</p></body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'content_length');
      expect(signal?.score).toBeCloseTo(0.5, 5);
    });
  });

  // ─── Rich Content Tests ──────────────────────────────────────────

  describe('rich content detection', () => {
    it('AC-2: 2000 chars, low boilerplate → quality = rich, score > 0.7', () => {
      const text = 'A'.repeat(2000);
      const html = `<html><head><title>Rich Article</title><meta name="description" content="A great article"></head><body><article><p>${text}</p></article></body></html>`;
      const result = gate.score(html, text);
      expect(result.score).toBeGreaterThan(0.7);
      expect(result.quality).toBe('rich');
      expect(result.shouldBlock).toBe(false);
    });

    it('rich content with meta tags scores highest', () => {
      const text = 'A'.repeat(2000);
      const html = `<html><head><title>Great Page</title><meta name="description" content="Useful page"></head><body><main><p>${text}</p></main></body></html>`;
      const result = gate.score(html, text);
      expect(result.score).toBeGreaterThanOrEqual(0.7);
      expect(result.quality).toBe('rich');
    });
  });

  // ─── SPA Shell Tests ─────────────────────────────────────────────

  describe('SPA shell detection', () => {
    it('AC-3: SPA shell <div id="root"></div> → shouldBlock = true', () => {
      const html = '<html><body><div id="root"></div></body></html>';
      const text = '';
      const result = gate.score(html, text);
      expect(result.shouldBlock).toBe(true);
      expect(result.quality).toBe('thin');
    });

    it('SPA shell with minimal JS framework boilerplate → blocked', () => {
      const html =
        '<html><head><script src="bundle.js"></script></head><body><div id="app"></div></body></html>';
      const result = gate.score(html, '');
      expect(result.shouldBlock).toBe(true);
    });
  });

  // ─── Boilerplate Ratio Tests ─────────────────────────────────────

  describe('boilerplate_ratio signal', () => {
    it('AC-4: 80% nav/footer text → boilerplateRatio > 0.7, score penalized', () => {
      // 400 chars in nav, 100 chars of real content = 80% boilerplate
      const navText = 'N'.repeat(400);
      const bodyText = 'B'.repeat(100);
      const text = navText + bodyText;
      const html = `<html><body><nav>${navText}</nav><main>${bodyText}</main></body></html>`;
      const result = gate.score(html, text);
      expect(result.boilerplateRatio).toBeGreaterThan(0.7);
      // contentGate = 0.5, boilerplate = 0.8:
      // 0.4*0.5 + 0.35*0.2*0.5 + 0.25*1*0.5 = 0.2 + 0.035 + 0.125 = 0.36
      expect(result.score).toBeLessThan(0.5);
    });

    it('page with all content in footer → high boilerplate ratio', () => {
      const footerText = 'F'.repeat(500);
      const html = `<html><body><footer>${footerText}</footer></body></html>`;
      const result = gate.score(html, footerText);
      expect(result.boilerplateRatio).toBeGreaterThanOrEqual(0.9);
    });

    it('page with zero boilerplate → boilerplateRatio = 0', () => {
      const text = 'A'.repeat(500);
      const html = `<html><head><title>Page</title></head><body><article><p>${text}</p></article></body></html>`;
      const result = gate.score(html, text);
      expect(result.boilerplateRatio).toBe(0);
      const signal = result.signals.find((s) => s.name === 'boilerplate_ratio');
      expect(signal?.score).toBe(1);
    });

    it('aside elements count as boilerplate', () => {
      const asideText = 'S'.repeat(400);
      const mainText = 'M'.repeat(100);
      const text = asideText + mainText;
      const html = `<html><body><aside>${asideText}</aside><main>${mainText}</main></body></html>`;
      const result = gate.score(html, text);
      expect(result.boilerplateRatio).toBeGreaterThan(0.5);
    });
  });

  // ─── Hidden Content Tests ────────────────────────────────────────

  describe('hidden_content signal', () => {
    it('aria-hidden elements are penalized', () => {
      const text = 'A'.repeat(500);
      const hiddenDivs = Array.from(
        { length: 20 },
        () => '<div aria-hidden="true">Hidden</div>',
      ).join('');
      const html = `<html><head><title>Page</title></head><body>${hiddenDivs}<p>${text}</p></body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'hidden_content');
      expect(signal?.value).toBeGreaterThan(0);
    });

    it('display:none elements are penalized', () => {
      const text = 'A'.repeat(500);
      const hiddenDivs = Array.from(
        { length: 20 },
        () => '<div style="display:none">Hidden stuff</div>',
      ).join('');
      const html = `<html><head><title>Page</title></head><body>${hiddenDivs}<p>${text}</p></body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'hidden_content');
      expect(signal?.value).toBeGreaterThan(0);
    });

    it('.sr-only elements are counted as hidden', () => {
      const text = 'A'.repeat(500);
      const srOnly = Array.from(
        { length: 15 },
        () => '<span class="sr-only">Screen reader text</span>',
      ).join('');
      const html = `<html><head><title>Page</title></head><body>${srOnly}<p>${text}</p></body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'hidden_content');
      expect(signal?.value).toBeGreaterThan(0);
    });

    it('page with no hidden elements has hidden ratio = 0', () => {
      const text = 'A'.repeat(500);
      const html = `<html><head><title>Page</title></head><body><p>${text}</p></body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'hidden_content');
      expect(signal?.value).toBe(0);
    });
  });

  // ─── Meta Quality Signal Tests ───────────────────────────────────

  describe('meta_quality signal', () => {
    it('page with title and description scores 1.0', () => {
      const text = 'A'.repeat(500);
      const html = `<html><head><title>My Page</title><meta name="description" content="A useful page"></head><body>${text}</body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'meta_quality');
      expect(signal?.score).toBe(1);
    });

    it('page with only title scores 0.5', () => {
      const text = 'A'.repeat(500);
      const html = `<html><head><title>My Page</title></head><body>${text}</body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'meta_quality');
      expect(signal?.score).toBe(0.5);
    });

    it('page with no title or description scores 0', () => {
      const text = 'A'.repeat(500);
      const html = `<html><head></head><body>${text}</body></html>`;
      const result = gate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'meta_quality');
      expect(signal?.score).toBe(0);
    });
  });

  // ─── Composite Score Tests ───────────────────────────────────────

  describe('composite score', () => {
    it('score is clamped between 0.0 and 1.0', () => {
      // Extreme case: empty everything
      const result1 = gate.score('', '');
      expect(result1.score).toBeGreaterThanOrEqual(0);
      expect(result1.score).toBeLessThanOrEqual(1);

      // Extreme case: rich content
      const text = 'A'.repeat(5000);
      const html = `<html><head><title>Rich</title><meta name="description" content="Great"></head><body><p>${text}</p></body></html>`;
      const result2 = gate.score(html, text);
      expect(result2.score).toBeGreaterThanOrEqual(0);
      expect(result2.score).toBeLessThanOrEqual(1);
    });

    it('quality bucket boundaries: >= 0.7 = rich', () => {
      const text = 'A'.repeat(2000);
      const html = `<html><head><title>Rich</title><meta name="description" content="Good"></head><body><p>${text}</p></body></html>`;
      const result = gate.score(html, text);
      expect(result.quality).toBe('rich');
    });

    it('quality bucket boundaries: 0.3–0.7 = standard', () => {
      // 500 chars text, no boilerplate, no meta → contentGate=0.5
      // score = 0.4*0.5 + 0.35*1*0.5 + 0.25*1*0.5 = 0.2 + 0.175 + 0.125 = 0.5
      const text = 'A'.repeat(500);
      const html = `<html><body><p>${text}</p></body></html>`;
      const result = gate.score(html, text);
      expect(result.quality).toBe('standard');
      expect(result.score).toBeGreaterThanOrEqual(0.3);
      expect(result.score).toBeLessThan(0.7);
    });

    it('quality bucket boundaries: < 0.3 = thin', () => {
      const result = gate.score('<html><body></body></html>', '');
      expect(result.quality).toBe('thin');
      expect(result.score).toBeLessThan(0.3);
    });
  });

  // ─── Config Override Tests ───────────────────────────────────────

  describe('config overrides', () => {
    it('respects custom blockThreshold', () => {
      const strictGate = new QualityGate({ blockThreshold: 0.8 });
      const lenientGate = new QualityGate({ blockThreshold: 0.1 });

      const text = 'A'.repeat(600);
      const html = `<html><head><title>Page</title></head><body><p>${text}</p></body></html>`;

      const strictResult = strictGate.score(html, text);
      const lenientResult = lenientGate.score(html, text);

      // Same score, different block decisions
      expect(strictResult.score).toBeCloseTo(lenientResult.score, 5);
      expect(strictResult.shouldBlock).toBe(true);
      expect(lenientResult.shouldBlock).toBe(false);
    });

    it('respects custom minContentLength', () => {
      const customGate = new QualityGate({ minContentLength: 100 });
      const text = 'A'.repeat(150);
      const html = `<html><head><title>Page</title></head><body>${text}</body></html>`;
      const result = customGate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'content_length');
      expect(signal?.threshold).toBe(100);
      expect(signal?.description).toContain('meets minimum');
    });

    it('respects custom maxBoilerplateRatio', () => {
      const customGate = new QualityGate({ maxBoilerplateRatio: 0.9 });
      const navText = 'N'.repeat(800);
      const bodyText = 'B'.repeat(200);
      const text = navText + bodyText;
      const html = `<html><body><nav>${navText}</nav><main>${bodyText}</main></body></html>`;
      const result = customGate.score(html, text);
      const signal = result.signals.find((s) => s.name === 'boilerplate_ratio');
      expect(signal?.threshold).toBe(0.9);
    });
  });

  // ─── Batch Scoring Tests ─────────────────────────────────────────

  describe('scoreBatch', () => {
    it('returns per-URL results with aggregate stats', () => {
      const pages = [
        {
          url: 'https://thin.example.com',
          html: '<html><body><div id="root"></div></body></html>',
          text: '',
        },
        {
          url: 'https://rich.example.com',
          html: `<html><head><title>Rich</title><meta name="description" content="Good"></head><body><p>${'A'.repeat(2000)}</p></body></html>`,
          text: 'A'.repeat(2000),
        },
      ];

      const batch = gate.scoreBatch(pages);

      expect(batch.results).toHaveLength(2);
      expect(batch.results[0].url).toBe('https://thin.example.com');
      expect(batch.results[0].result.shouldBlock).toBe(true);
      expect(batch.results[1].url).toBe('https://rich.example.com');
      expect(batch.results[1].result.shouldBlock).toBe(false);

      expect(batch.stats.total).toBe(2);
      expect(batch.stats.blocked).toBe(1);
      expect(batch.stats.blockRate).toBe(0.5);
    });

    it('handles empty batch', () => {
      const batch = gate.scoreBatch([]);
      expect(batch.results).toHaveLength(0);
      expect(batch.stats.total).toBe(0);
      expect(batch.stats.blocked).toBe(0);
      expect(batch.stats.blockRate).toBe(0);
    });

    it('batch with all blocked pages', () => {
      const pages = [
        { url: 'https://a.com', html: '<html><body></body></html>', text: '' },
        { url: 'https://b.com', html: '<html><body></body></html>', text: 'tiny' },
      ];
      const batch = gate.scoreBatch(pages);
      expect(batch.stats.blocked).toBe(2);
      expect(batch.stats.blockRate).toBe(1);
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty HTML string without crashing', () => {
      const result = gate.score('', '');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(typeof result.shouldBlock).toBe('boolean');
    });

    it('handles null/undefined inputs gracefully', () => {
      const result = gate.score(undefined as unknown as string, null as unknown as string);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('handles malformed HTML without crashing', () => {
      const result = gate.score('<<<>>>not<valid><<<<html>>>>>', 'some text');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('returns all 4 signals', () => {
      const result = gate.score('<html><body>Hello</body></html>', 'Hello');
      expect(result.signals).toHaveLength(4);
      const names = result.signals.map((s) => s.name);
      expect(names).toContain('content_length');
      expect(names).toContain('boilerplate_ratio');
      expect(names).toContain('hidden_content');
      expect(names).toContain('meta_quality');
    });

    it('contentLength in result matches text length', () => {
      const text = 'A'.repeat(350);
      const result = gate.score(`<html><body>${text}</body></html>`, text);
      expect(result.contentLength).toBe(350);
    });
  });

  // ─── WithDom Parity Tests ────────────────────────────────────────

  describe('scoreWithDom parity', () => {
    it('scoreWithDom returns identical result to score for the same HTML', () => {
      const text = 'A'.repeat(1500);
      const html = `<html><head><title>Parity Test</title><meta name="description" content="Testing parity"></head><body><nav>${'N'.repeat(200)}</nav><article><p>${text}</p></article><div aria-hidden="true">Hidden</div></body></html>`;

      const resultFromScore = gate.score(html, text);
      const $ = cheerio.load(html);
      const resultFromDom = gate.scoreWithDom($, text);

      expect(resultFromDom).toEqual(resultFromScore);
    });
  });

  // ─── Reason String Tests ─────────────────────────────────────────

  describe('reason string', () => {
    it('includes quality bucket in reason', () => {
      const text = 'A'.repeat(2000);
      const html = `<html><head><title>Page</title><meta name="description" content="Good"></head><body>${text}</body></html>`;
      const result = gate.score(html, text);
      expect(result.reason).toContain('rich');
      expect(result.reason).toContain('passes quality gate');
    });

    it('includes block notice for thin content', () => {
      const result = gate.score('<html><body></body></html>', '');
      expect(result.reason).toContain('thin');
      expect(result.reason).toContain('blocked');
    });
  });
});
