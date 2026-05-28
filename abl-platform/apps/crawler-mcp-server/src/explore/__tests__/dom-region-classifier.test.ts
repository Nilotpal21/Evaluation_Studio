/**
 * DOM Region Classifier — Pure Function Tests
 *
 * Tests the classifyRegions() pure function with synthetic DOM data.
 * No Playwright dependency needed — the bridge function is tested
 * via manual validation in Phase 5.
 *
 * Test location: co-located with explore source (not top-level __tests__/).
 * The existing src/__tests__/ holds HTTP transport integration tests;
 * these are module-scoped unit tests for explore logic.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyRegions,
  REGION_CLICK_PRIORITY,
  type RawDomElement,
  type DomRegion,
} from '../dom-region-classifier.js';

// ─── Test Helpers ───────────────────────────────────────────────────

const VIEWPORT = { width: 1280, height: 800 };

function makeElement(overrides: Partial<RawDomElement>): RawDomElement {
  return {
    selector: overrides.selector ?? 'div:nth-child(1)',
    tagName: overrides.tagName ?? 'div',
    role: overrides.role ?? null,
    rect: overrides.rect ?? { top: 100, left: 200, width: 800, height: 500 },
    viewport: overrides.viewport ?? VIEWPORT,
    expandableCount: overrides.expandableCount ?? 0,
    linkCount: overrides.linkCount ?? 0,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('classifyRegions', () => {
  describe('landmark classification', () => {
    it('classifies <main> as content-main', () => {
      const elements = [
        makeElement({
          selector: 'main',
          tagName: 'main',
          rect: { top: 100, left: 200, width: 800, height: 600 },
          expandableCount: 5,
          linkCount: 20,
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('content-main');
      expect(regions[0].source).toBe('landmark');
      expect(regions[0].expandableCount).toBe(5);
      expect(regions[0].linkCount).toBe(20);
    });

    it('classifies [role="main"] as content-main', () => {
      const elements = [
        makeElement({
          selector: '#content',
          tagName: 'div',
          role: 'main',
          rect: { top: 80, left: 200, width: 900, height: 600 },
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('content-main');
      expect(regions[0].source).toBe('landmark');
    });

    it('classifies top-wide <nav> as nav-header', () => {
      const elements = [
        makeElement({
          selector: 'nav:nth-child(1)',
          tagName: 'nav',
          rect: { top: 0, left: 0, width: 1280, height: 60 },
          linkCount: 15,
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('nav-header');
      expect(regions[0].source).toBe('landmark');
    });

    it('classifies left-tall <nav> as nav-sidebar', () => {
      const elements = [
        makeElement({
          selector: 'nav:nth-child(2)',
          tagName: 'nav',
          rect: { top: 60, left: 0, width: 250, height: 700 },
          expandableCount: 10,
          linkCount: 30,
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('nav-sidebar');
      expect(regions[0].source).toBe('landmark');
    });

    it('classifies <aside> as aside', () => {
      const elements = [
        makeElement({
          selector: 'aside',
          tagName: 'aside',
          rect: { top: 100, left: 900, width: 300, height: 500 },
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('aside');
      expect(regions[0].source).toBe('landmark');
    });

    it('classifies <footer> as footer', () => {
      const elements = [
        makeElement({
          selector: 'footer',
          tagName: 'footer',
          rect: { top: 750, left: 0, width: 1280, height: 50 },
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('footer');
      expect(regions[0].source).toBe('landmark');
    });

    it('classifies [role="contentinfo"] as footer', () => {
      const elements = [
        makeElement({
          selector: '#footer-section',
          tagName: 'div',
          role: 'contentinfo',
          rect: { top: 750, left: 0, width: 1280, height: 50 },
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('footer');
      expect(regions[0].source).toBe('landmark');
    });
  });

  describe('spatial classification (no landmarks)', () => {
    it('classifies top-wide element as nav-header', () => {
      const elements = [
        makeElement({
          selector: 'div:nth-child(1)',
          tagName: 'div',
          rect: { top: 0, left: 0, width: 1280, height: 70 },
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('nav-header');
      expect(regions[0].source).toBe('spatial');
    });

    it('classifies left-tall-narrow element as nav-sidebar', () => {
      const elements = [
        makeElement({
          selector: 'div:nth-child(2)',
          tagName: 'div',
          rect: { top: 80, left: 0, width: 280, height: 600 },
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('nav-sidebar');
      expect(regions[0].source).toBe('spatial');
    });

    it('classifies bottom-wide element as footer', () => {
      const elements = [
        makeElement({
          selector: 'div:nth-child(3)',
          tagName: 'div',
          rect: { top: 750, left: 0, width: 1280, height: 50 },
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('footer');
      expect(regions[0].source).toBe('spatial');
    });
  });

  describe('priority sorting', () => {
    it('sorts content-main before nav-header before footer', () => {
      const elements = [
        // Footer first in DOM order
        makeElement({
          selector: 'footer',
          tagName: 'footer',
          rect: { top: 750, left: 0, width: 1280, height: 50 },
        }),
        // Nav second in DOM order
        makeElement({
          selector: 'nav',
          tagName: 'nav',
          rect: { top: 0, left: 0, width: 1280, height: 60 },
        }),
        // Main third in DOM order
        makeElement({
          selector: 'main',
          tagName: 'main',
          rect: { top: 80, left: 200, width: 800, height: 600 },
          expandableCount: 10,
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(3);
      // content-main should be first (priority 0)
      expect(regions[0].role).toBe('content-main');
      // nav-header should be second (priority 4)
      expect(regions[1].role).toBe('nav-header');
      // footer should be last (priority 5)
      expect(regions[2].role).toBe('footer');
    });

    it('sorts sidebar before unknown before header', () => {
      const elements = [
        // Unknown element
        makeElement({
          selector: 'div:nth-child(1)',
          tagName: 'div',
          rect: { top: 200, left: 400, width: 400, height: 300 },
        }),
        // Sidebar nav
        makeElement({
          selector: 'nav:nth-child(2)',
          tagName: 'nav',
          rect: { top: 80, left: 0, width: 250, height: 600 },
        }),
        // Header nav
        makeElement({
          selector: 'nav:nth-child(1)',
          tagName: 'nav',
          rect: { top: 0, left: 0, width: 1280, height: 60 },
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions.length).toBeGreaterThanOrEqual(2);
      const roles = regions.map((r) => r.role);
      const sidebarIdx = roles.indexOf('nav-sidebar');
      const headerIdx = roles.indexOf('nav-header');
      expect(sidebarIdx).toBeLessThan(headerIdx);
    });
  });

  describe('edge cases', () => {
    it('skips tiny elements (< 1% viewport area)', () => {
      const elements = [
        makeElement({
          selector: 'nav',
          tagName: 'nav',
          rect: { top: 0, left: 0, width: 50, height: 20 }, // 0.1% of viewport
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
      const regions = classifyRegions([]);
      expect(regions).toHaveLength(0);
    });

    it('handles zero viewport dimensions gracefully', () => {
      const elements = [
        makeElement({
          selector: 'main',
          tagName: 'main',
          rect: { top: 0, left: 0, width: 800, height: 600 },
          viewport: { width: 0, height: 0 },
        }),
      ];

      // Should not crash, but element will be skipped (0% area)
      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(0);
    });

    it('handles single-region page (only main content)', () => {
      const elements = [
        makeElement({
          selector: 'main',
          tagName: 'main',
          rect: { top: 0, left: 0, width: 1280, height: 800 },
          expandableCount: 15,
          linkCount: 50,
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(1);
      expect(regions[0].role).toBe('content-main');
      expect(regions[0].expandableCount).toBe(15);
    });

    it('preserves expandable and link counts per region', () => {
      const elements = [
        makeElement({
          selector: 'main',
          tagName: 'main',
          rect: { top: 80, left: 200, width: 800, height: 600 },
          expandableCount: 12,
          linkCount: 45,
        }),
        makeElement({
          selector: 'nav',
          tagName: 'nav',
          rect: { top: 0, left: 0, width: 1280, height: 60 },
          expandableCount: 3,
          linkCount: 8,
        }),
      ];

      const regions = classifyRegions(elements);
      const main = regions.find((r) => r.role === 'content-main');
      const nav = regions.find((r) => r.role === 'nav-header');
      expect(main?.expandableCount).toBe(12);
      expect(main?.linkCount).toBe(45);
      expect(nav?.expandableCount).toBe(3);
      expect(nav?.linkCount).toBe(8);
    });
  });

  describe('mixed classification (landmark + spatial)', () => {
    it('classifies a typical page with header, sidebar, main, footer', () => {
      const elements = [
        // Header with <header> tag
        makeElement({
          selector: 'header',
          tagName: 'header',
          rect: { top: 0, left: 0, width: 1280, height: 60 },
          linkCount: 10,
        }),
        // Sidebar with <nav> tag
        makeElement({
          selector: 'nav:nth-child(2)',
          tagName: 'nav',
          rect: { top: 60, left: 0, width: 250, height: 680 },
          expandableCount: 8,
          linkCount: 25,
        }),
        // Main content with <main> tag
        makeElement({
          selector: 'main',
          tagName: 'main',
          rect: { top: 60, left: 250, width: 1030, height: 680 },
          expandableCount: 15,
          linkCount: 40,
        }),
        // Footer with <footer> tag
        makeElement({
          selector: 'footer',
          tagName: 'footer',
          rect: { top: 740, left: 0, width: 1280, height: 60 },
          linkCount: 5,
        }),
      ];

      const regions = classifyRegions(elements);
      expect(regions).toHaveLength(4);

      // Check priority order: content-main (0) → nav-sidebar (1) → nav-header (4) → footer (5)
      expect(regions[0].role).toBe('content-main');
      expect(regions[1].role).toBe('nav-sidebar');
      expect(regions[2].role).toBe('nav-header');
      expect(regions[3].role).toBe('footer');

      // Check sources
      expect(regions[0].source).toBe('landmark');
      expect(regions[1].source).toBe('landmark');
      expect(regions[2].source).toBe('landmark');
      expect(regions[3].source).toBe('landmark');
    });
  });
});

describe('REGION_CLICK_PRIORITY', () => {
  it('has content-main as highest priority (0)', () => {
    expect(REGION_CLICK_PRIORITY['content-main']).toBe(0);
  });

  it('has footer as lowest priority (5)', () => {
    expect(REGION_CLICK_PRIORITY['footer']).toBe(5);
  });

  it('has nav-sidebar before nav-header', () => {
    expect(REGION_CLICK_PRIORITY['nav-sidebar']).toBeLessThan(REGION_CLICK_PRIORITY['nav-header']);
  });
});
