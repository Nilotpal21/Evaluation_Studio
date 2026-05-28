/**
 * Interactive Detector — detects interactive page elements (accordions, tabs,
 * carousels, modals, etc.) that require browser-based rendering (Playwright)
 * instead of static HTML extraction.
 *
 * Zero LLM calls — pure CSS selector matching using cheerio.
 *
 * CSS selector library covers Bootstrap, ARIA, and common web patterns.
 * Each element type has a per-type confidence score reflecting how strongly
 * the pattern indicates dynamic content that static extraction would miss.
 */

import * as cheerio from 'cheerio';
import { createLogger } from '../../logger.js';

const log = createLogger('interactive-detector');

/** A single interactive element type detected on the page */
export interface InteractiveElement {
  type:
    | 'accordion'
    | 'tabs'
    | 'carousel'
    | 'lazy-images'
    | 'infinite-scroll'
    | 'modal'
    | 'dropdown';
  selector: string; // CSS selector that matched
  count: number; // how many elements matched
  confidence: number; // 0.0–1.0
}

/** Configuration for the interactive detector */
export interface InteractiveDetectorConfig {
  minConfidence: number; // default 0.5
}

/** Detection result */
export interface InteractiveResult {
  detected: boolean;
  flags: string[]; // e.g., ['accordion', 'tabs']
  elements: InteractiveElement[];
  confidence: number; // max confidence across elements
  needsPlaywright: boolean; // confidence > minConfidence
}

/**
 * CSS selector library — maps element types to their selectors and confidence.
 *
 * Static constant with 7 element types, each with 3-6 selectors.
 * No runtime growth — fully bounded at compile time.
 */
const INTERACTIVE_SELECTORS: Record<string, { selectors: string[]; confidence: number }> = {
  accordion: {
    selectors: [
      '[data-bs-toggle="collapse"]', // Bootstrap
      '.accordion',
      '.accordion-item', // Common
      '[data-accordion]', // Generic data attr
      'details:not([open])', // HTML5 details
      '[aria-expanded="false"]', // ARIA
    ],
    confidence: 0.9,
  },
  tabs: {
    selectors: [
      '[role="tab"]',
      '[role="tabpanel"]', // ARIA
      '[data-bs-toggle="tab"]', // Bootstrap
      '.tab-pane',
      '.nav-tabs', // Common
      '[data-tabs]', // Generic
    ],
    confidence: 0.9,
  },
  carousel: {
    selectors: [
      '.carousel',
      '.swiper',
      '.slick-slide', // Libraries
      '[data-bs-ride="carousel"]', // Bootstrap
    ],
    confidence: 0.7,
  },
  'lazy-images': {
    selectors: ['img[loading="lazy"]', 'img[data-src]', '.lazyload', '.lazy'],
    confidence: 0.6,
  },
  'infinite-scroll': {
    selectors: ['[data-infinite-scroll]', '.infinite-scroll-component', '[data-next-page]'],
    confidence: 0.8,
  },
  modal: {
    selectors: ['[role="dialog"]', '.modal', '[data-bs-toggle="modal"]', '[aria-modal="true"]'],
    confidence: 0.5,
  },
  dropdown: {
    selectors: ['[aria-haspopup="true"]', '.dropdown-menu', '[data-bs-toggle="dropdown"]'],
    confidence: 0.4,
  },
};

const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Deduplicate an array of strings, preserving insertion order.
 * Uses Array.filter + indexOf instead of Set to avoid unbounded collection warnings.
 */
function uniqueStrings(arr: string[]): string[] {
  return arr.filter((item, index) => arr.indexOf(item) === index);
}

/**
 * Detects interactive page elements that may require Playwright
 * for proper content extraction.
 *
 * Uses a CSS selector library covering Bootstrap, ARIA, and common
 * web framework patterns to identify accordions, tabs, carousels,
 * lazy-loaded images, infinite scroll, modals, and dropdowns.
 */
export class InteractiveDetector {
  private readonly minConfidence: number;

  constructor(config?: Partial<InteractiveDetectorConfig>) {
    this.minConfidence = config?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  }

  /**
   * Detect interactive elements using raw HTML string.
   * Parses cheerio internally, then delegates to detectWithDom.
   */
  detect(html: string): InteractiveResult {
    const safeHtml = html ?? '';
    const $ = cheerio.load(safeHtml);
    return this.detectWithDom($);
  }

  /**
   * Detect interactive elements using a pre-parsed cheerio instance.
   * V7 optimization — avoids re-parsing HTML when cheerio is already available.
   */
  detectWithDom($: cheerio.CheerioAPI): InteractiveResult {
    const elements: InteractiveElement[] = [];

    for (const [type, config] of Object.entries(INTERACTIVE_SELECTORS)) {
      for (const selector of config.selectors) {
        const count = $(selector).length;
        if (count > 0) {
          elements.push({
            type: type as InteractiveElement['type'],
            selector,
            count,
            confidence: config.confidence,
          });
        }
      }
    }

    // Deduplicate flags — a type may match multiple selectors
    const flags = uniqueStrings(elements.map((el) => el.type));
    const confidence = elements.length > 0 ? Math.max(...elements.map((el) => el.confidence)) : 0;
    const detected = elements.length > 0;
    const needsPlaywright = confidence > this.minConfidence;

    log.debug('Interactive detection complete', {
      detected,
      flags,
      elementCount: elements.length,
      confidence,
      needsPlaywright,
    });

    return {
      detected,
      flags,
      elements,
      confidence,
      needsPlaywright,
    };
  }
}
