import * as cheerio from 'cheerio';
import { describe, it, expect } from 'vitest';
import { InteractiveDetector } from '../../intelligence/algorithms/interactive-detector.js';

describe('InteractiveDetector', () => {
  const detector = new InteractiveDetector();

  // ─── Accordion Detection ──────────────────────────────────────────

  describe('accordion detection', () => {
    it('AC-1: [aria-expanded="false"] → flags includes accordion, needsPlaywright = true', () => {
      const html = '<html><body><div aria-expanded="false">Hidden content</div></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('accordion');
      expect(result.needsPlaywright).toBe(true);
    });

    it('Bootstrap collapse pattern: [data-bs-toggle="collapse"]', () => {
      const html =
        '<html><body><button data-bs-toggle="collapse" data-bs-target="#demo">Toggle</button><div id="demo" class="collapse">Content</div></body></html>';
      const result = detector.detect(html);
      expect(result.flags).toContain('accordion');
      expect(result.confidence).toBe(0.9);
    });

    it('HTML5 details element (not open) detected as accordion', () => {
      const html =
        '<html><body><details><summary>More info</summary><p>Hidden details</p></details></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('accordion');
    });
  });

  // ─── Tabs Detection ───────────────────────────────────────────────

  describe('tabs detection', () => {
    it('AC-2: [role="tab"] → flags includes tabs', () => {
      const html =
        '<html><body><div role="tablist"><button role="tab">Tab 1</button><button role="tab">Tab 2</button></div></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('tabs');
    });

    it('Bootstrap tab pattern: [data-bs-toggle="tab"]', () => {
      const html =
        '<html><body><ul class="nav-tabs"><li><a data-bs-toggle="tab" href="#t1">Tab</a></li></ul></body></html>';
      const result = detector.detect(html);
      expect(result.flags).toContain('tabs');
    });
  });

  // ─── Carousel Detection ───────────────────────────────────────────

  describe('carousel detection', () => {
    it('.swiper → flags includes carousel', () => {
      const html =
        '<html><body><div class="swiper"><div class="swiper-wrapper"><div class="swiper-slide">Slide 1</div></div></div></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('carousel');
      expect(result.confidence).toBe(0.7);
    });

    it('Bootstrap carousel: [data-bs-ride="carousel"]', () => {
      const html =
        '<html><body><div data-bs-ride="carousel"><div class="carousel-inner">Slides</div></div></body></html>';
      const result = detector.detect(html);
      expect(result.flags).toContain('carousel');
    });
  });

  // ─── Lazy Images Detection ────────────────────────────────────────

  describe('lazy-images detection', () => {
    it('AC-3: img[loading="lazy"] → flags includes lazy-images, confidence = 0.6', () => {
      const html =
        '<html><body><img loading="lazy" src="photo.jpg" alt="Photo"><img loading="lazy" src="photo2.jpg" alt="Photo 2"></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('lazy-images');
      expect(result.confidence).toBe(0.6);
    });

    it('img[data-src] detected as lazy-images', () => {
      const html = '<html><body><img data-src="deferred.jpg" alt="Deferred"></body></html>';
      const result = detector.detect(html);
      expect(result.flags).toContain('lazy-images');
    });
  });

  // ─── Infinite Scroll Detection ────────────────────────────────────

  describe('infinite-scroll detection', () => {
    it('[data-infinite-scroll] → flags includes infinite-scroll', () => {
      const html =
        '<html><body><div data-infinite-scroll="true"><div>Item 1</div></div></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('infinite-scroll');
      expect(result.confidence).toBe(0.8);
    });
  });

  // ─── Modal Detection ──────────────────────────────────────────────

  describe('modal detection', () => {
    it('[role="dialog"] → flags includes modal', () => {
      const html =
        '<html><body><div role="dialog" aria-label="Settings">Modal content</div></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('modal');
    });
  });

  // ─── Dropdown Detection ───────────────────────────────────────────

  describe('dropdown detection', () => {
    it('[aria-haspopup="true"] → flags includes dropdown', () => {
      const html =
        '<html><body><button aria-haspopup="true">Menu</button><div class="dropdown-menu">Items</div></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('dropdown');
    });
  });

  // ─── No Interactive Elements ──────────────────────────────────────

  describe('no interactive elements', () => {
    it('AC-4: plain HTML → detected = false, flags = []', () => {
      const html =
        '<html><head><title>Simple Page</title></head><body><h1>Hello</h1><p>Just a paragraph.</p></body></html>';
      const result = detector.detect(html);
      expect(result.detected).toBe(false);
      expect(result.flags).toEqual([]);
      expect(result.elements).toEqual([]);
      expect(result.confidence).toBe(0);
      expect(result.needsPlaywright).toBe(false);
    });

    it('empty HTML → detected = false', () => {
      const result = detector.detect('');
      expect(result.detected).toBe(false);
      expect(result.flags).toEqual([]);
      expect(result.confidence).toBe(0);
      expect(result.needsPlaywright).toBe(false);
    });
  });

  // ─── Multiple Types ───────────────────────────────────────────────

  describe('multiple types on same page', () => {
    it('accordion + tabs + carousel → all detected, confidence = max', () => {
      const html = `<html><body>
        <div aria-expanded="false">Accordion</div>
        <div role="tab">Tab</div>
        <div class="swiper">Carousel</div>
      </body></html>`;
      const result = detector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('accordion');
      expect(result.flags).toContain('tabs');
      expect(result.flags).toContain('carousel');
      // Max confidence is 0.9 from accordion or tabs
      expect(result.confidence).toBe(0.9);
      expect(result.needsPlaywright).toBe(true);
    });

    it('flags are deduplicated when multiple selectors match same type', () => {
      const html = `<html><body>
        <div role="tab">Tab 1</div>
        <div role="tabpanel">Panel</div>
        <ul class="nav-tabs"><li>Tab</li></ul>
      </body></html>`;
      const result = detector.detect(html);
      // Should only have 'tabs' once despite 3 selectors matching
      const tabFlags = result.flags.filter((f) => f === 'tabs');
      expect(tabFlags).toHaveLength(1);
    });
  });

  // ─── detect vs detectWithDom Parity ───────────────────────────────

  describe('detect vs detectWithDom parity', () => {
    it('AC-5: detect(html) and detectWithDom($) return identical results', () => {
      const html = `<html><body>
        <div aria-expanded="false">Accordion</div>
        <img loading="lazy" src="photo.jpg" alt="Photo">
        <button aria-haspopup="true">Menu</button>
      </body></html>`;

      const resultFromHtml = detector.detect(html);
      const $ = cheerio.load(html);
      const resultFromDom = detector.detectWithDom($);

      expect(resultFromHtml.detected).toBe(resultFromDom.detected);
      expect(resultFromHtml.flags).toEqual(resultFromDom.flags);
      expect(resultFromHtml.confidence).toBe(resultFromDom.confidence);
      expect(resultFromHtml.needsPlaywright).toBe(resultFromDom.needsPlaywright);
      expect(resultFromHtml.elements).toEqual(resultFromDom.elements);
    });
  });

  // ─── Config Override ──────────────────────────────────────────────

  describe('config overrides', () => {
    it('custom minConfidence = 0.8 → dropdown (0.4) does not trigger needsPlaywright', () => {
      const strictDetector = new InteractiveDetector({ minConfidence: 0.8 });
      const html = '<html><body><button aria-haspopup="true">Menu</button></body></html>';
      const result = strictDetector.detect(html);
      expect(result.detected).toBe(true);
      expect(result.flags).toContain('dropdown');
      expect(result.confidence).toBe(0.4);
      expect(result.needsPlaywright).toBe(false);
    });

    it('custom minConfidence = 0.3 → dropdown (0.4) does trigger needsPlaywright', () => {
      const lenientDetector = new InteractiveDetector({ minConfidence: 0.3 });
      const html = '<html><body><button aria-haspopup="true">Menu</button></body></html>';
      const result = lenientDetector.detect(html);
      expect(result.needsPlaywright).toBe(true);
    });
  });

  // ─── needsPlaywright Threshold Behavior ───────────────────────────

  describe('needsPlaywright threshold behavior', () => {
    it('needsPlaywright is false when confidence equals minConfidence (0.5)', () => {
      // Modal has confidence 0.5, default minConfidence is 0.5
      // needsPlaywright = confidence > minConfidence (strict greater-than)
      const html = '<html><body><div role="dialog">Modal</div></body></html>';
      const result = detector.detect(html);
      expect(result.confidence).toBe(0.5);
      expect(result.needsPlaywright).toBe(false);
    });

    it('needsPlaywright is true when confidence exceeds minConfidence', () => {
      // lazy-images has confidence 0.6, default minConfidence is 0.5
      const html = '<html><body><img loading="lazy" src="photo.jpg" alt="Photo"></body></html>';
      const result = detector.detect(html);
      expect(result.confidence).toBe(0.6);
      expect(result.needsPlaywright).toBe(true);
    });
  });

  // ─── Element Count ────────────────────────────────────────────────

  describe('element count', () => {
    it('counts multiple matching elements per selector', () => {
      const html = `<html><body>
        <img loading="lazy" src="a.jpg" alt="A">
        <img loading="lazy" src="b.jpg" alt="B">
        <img loading="lazy" src="c.jpg" alt="C">
      </body></html>`;
      const result = detector.detect(html);
      const lazyImgElement = result.elements.find((el) => el.selector === 'img[loading="lazy"]');
      expect(lazyImgElement?.count).toBe(3);
    });
  });
});
