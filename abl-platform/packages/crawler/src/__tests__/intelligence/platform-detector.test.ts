import { describe, it, expect, vi } from 'vitest';
import { PlatformDetector } from '../../intelligence/algorithms/platform-detector.js';
import type { HttpAdapter, HttpFetchResult } from '../../intelligence/algorithms/http-adapter.js';

describe('PlatformDetector', () => {
  const detector = new PlatformDetector();

  // ─── Shopify ───────────────────────────────────────────────────────

  it('Shopify: cdn.shopify.com in script src → platform=shopify, category=ecommerce', () => {
    const html = `<html><head>
      <script src="https://cdn.shopify.com/s/files/1/theme.js"></script>
    </head><body><h1>My Shop</h1></body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('shopify');
    expect(result.category).toBe('ecommerce');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.apiEndpoints).toContain('/products.json');
  });

  // ─── WordPress ─────────────────────────────────────────────────────

  it('WordPress: generator meta tag → platform=wordpress, category=cms', () => {
    const html = `<html><head>
      <meta name="generator" content="WordPress 6.4.2">
    </head><body><h1>My Blog</h1></body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('wordpress');
    expect(result.category).toBe('cms');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  // ─── WooCommerce ───────────────────────────────────────────────────

  it('WooCommerce: .woocommerce class + WordPress signals → platform=woocommerce (not wordpress)', () => {
    const html = `<html><head>
      <meta name="generator" content="WordPress 6.4.2">
      <script src="/wp-content/plugins/woocommerce/assets/js/frontend.js"></script>
    </head><body>
      <div class="woocommerce"><div class="products">Products here</div></div>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('woocommerce');
    expect(result.category).toBe('ecommerce');
    // Must NOT be wordpress — woocommerce inherits and overrides
    expect(result.platform).not.toBe('wordpress');
  });

  // ─── Magento ───────────────────────────────────────────────────────

  it('Magento: x-magento-vary header via detectWithContext → platform=magento', () => {
    const html = '<html><body><h1>Store</h1></body></html>';
    const result = detector.detectWithContext(html, {
      headers: { 'X-Magento-Vary': 'abc123' },
    });
    expect(result.platform).toBe('magento');
    expect(result.category).toBe('ecommerce');
    expect(result.confidence).toBe(0.99);
  });

  // ─── Next.js ───────────────────────────────────────────────────────

  it('Next.js: #__next → platform=nextjs, category=framework', () => {
    const html = `<html><body>
      <div id="__next"><div>App content here</div></div>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('nextjs');
    expect(result.category).toBe('framework');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  // ─── React ─────────────────────────────────────────────────────────

  it('React: [data-reactroot] → platform=react', () => {
    const html = `<html><body>
      <div data-reactroot="">React app content</div>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('react');
    expect(result.category).toBe('framework');
  });

  // ─── Vue ───────────────────────────────────────────────────────────

  it('Vue: [data-v-] → platform=vue', () => {
    // Vue scoped CSS adds attributes like data-v-xxxxxxx. The selector [data-v-]
    // matches the exact attribute name "data-v-" which Vue also generates.
    const html = `<html><body>
      <div data-v->Vue component content</div>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('vue');
    expect(result.category).toBe('framework');
  });

  // ─── Angular ───────────────────────────────────────────────────────

  it('Angular: [ng-version] → platform=angular', () => {
    const html = `<html><body>
      <app-root ng-version="17.0.0">Angular app</app-root>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('angular');
    expect(result.category).toBe('framework');
  });

  // ─── Squarespace ───────────────────────────────────────────────────

  it('Squarespace: HTML comment → platform=squarespace', () => {
    const html = `<html><body>
      <!-- This is Squarespace. -->
      <h1>My Site</h1>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('squarespace');
    expect(result.category).toBe('cms');
  });

  // ─── Wix ───────────────────────────────────────────────────────────

  it('Wix: generator meta → platform=wix', () => {
    const html = `<html><head>
      <meta name="generator" content="Wix.com Website Builder">
    </head><body><h1>My Wix Site</h1></body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('wix');
    expect(result.category).toBe('cms');
  });

  // ─── Gatsby ────────────────────────────────────────────────────────

  it('Gatsby: #___gatsby → platform=gatsby', () => {
    const html = `<html><body>
      <div id="___gatsby"><div id="gatsby-focus-wrapper">Content</div></div>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('gatsby');
    expect(result.category).toBe('static-gen');
  });

  // ─── FALSE POSITIVE Regression ─────────────────────────────────────

  it('FALSE POSITIVE: page with text "I love React framework" but no React DOM markers → NOT react', () => {
    const html = `<html><body>
      <h1>Web Frameworks</h1>
      <p>I love React framework for building user interfaces. Vue is great too.</p>
      <p>Angular also has a strong ecosystem.</p>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).not.toBe('react');
    expect(result.platform).not.toBe('vue');
    expect(result.platform).not.toBe('angular');
    expect(result.category).toBe('unknown');
  });

  // ─── Unknown Site ──────────────────────────────────────────────────

  it('Unknown site → category=unknown, platform undefined', () => {
    const html = `<html><head><title>My Site</title></head>
    <body><h1>Hello World</h1><p>Just a simple page.</p></body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBeUndefined();
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.signals).toEqual([]);
  });

  // ─── Multiple Platforms Match ──────────────────────────────────────

  it('Multiple platforms match → highest confidence wins', () => {
    // Page has both Shopify (0.95) and Squarespace comment (0.95) — Shopify selector also matches
    // In practice, shopify has a meta-tag signal at 0.99 which is higher
    const html = `<html><head>
      <meta name="shopify-checkout-api-token" content="abc123">
    </head><body>
      <!-- This is Squarespace. -->
      <h1>Confusing Site</h1>
    </body></html>`;
    const result = detector.detect(html);
    // Shopify meta-tag signal has 0.99 confidence, higher than Squarespace comment at 0.95
    expect(result.platform).toBe('shopify');
    expect(result.confidence).toBe(0.99);
  });

  // ─── probeApis: 200 JSON → shopify ────────────────────────────────

  it('probeApis: /products.json returns 200 JSON → platform=shopify', async () => {
    const mockAdapter = {
      fetch: vi.fn().mockImplementation(async (url: string): Promise<HttpFetchResult> => {
        if (url.includes('/products.json')) {
          return {
            success: true,
            crawlResult: {
              url,
              statusCode: 200,
              title: '',
              html: JSON.stringify({ products: [{ id: 1, title: 'Product' }] }),
              text: '',
              links: [],
              metadata: {},
              crawledAt: new Date().toISOString(),
              duration: 100,
              success: true,
              contentLength: 100,
              contentType: 'application/json',
              depth: 0,
            },
            statusCode: 200,
            duration: 100,
          };
        }
        return { success: false, error: 'Not found', statusCode: 404, duration: 50 };
      }),
    } as unknown as HttpAdapter;

    const result = await detector.probeApis('https://example.com', mockAdapter);
    expect(result.platform).toBe('shopify');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.signals.some((s) => s.type === 'api-probe')).toBe(true);
  });

  // ─── probeApis: 404 → no detection ────────────────────────────────

  it('probeApis: /products.json returns 404 → no shopify detection from probe', async () => {
    const mockAdapter = {
      fetch: vi.fn().mockResolvedValue({
        success: false,
        error: 'HTTP 404',
        statusCode: 404,
        duration: 50,
      }),
    } as unknown as HttpAdapter;

    const result = await detector.probeApis('https://example.com', mockAdapter);
    expect(result.platform).toBeUndefined();
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  // ─── Config Override: minConfidence ────────────────────────────────

  it('Config override: high minConfidence filters out low-confidence matches', () => {
    const strictDetector = new PlatformDetector({ minConfidence: 0.99 });
    // Squarespace comment has 0.95 confidence — below 0.99 threshold
    const html = `<html><body>
      <!-- This is Squarespace. -->
      <h1>My Site</h1>
    </body></html>`;
    const result = strictDetector.detect(html);
    expect(result.platform).toBeUndefined();
    expect(result.category).toBe('unknown');
  });

  // ─── Empty HTML ────────────────────────────────────────────────────

  it('Empty HTML → category=unknown', () => {
    const result = detector.detect('');
    expect(result.platform).toBeUndefined();
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.signals).toEqual([]);
  });

  // ─── Nuxt ──────────────────────────────────────────────────────────

  it('Nuxt: #__nuxt → platform=nuxt', () => {
    const html = `<html><body>
      <div id="__nuxt"><div id="__layout">Content</div></div>
    </body></html>`;
    const result = detector.detect(html);
    expect(result.platform).toBe('nuxt');
    expect(result.category).toBe('framework');
  });

  // ─── Header detection via detectWithContext ────────────────────────

  it('Next.js: x-nextjs-cache header via detectWithContext → platform=nextjs', () => {
    const html = '<html><body><p>Content</p></body></html>';
    const result = detector.detectWithContext(html, {
      headers: { 'X-Nextjs-Cache': 'HIT' },
    });
    expect(result.platform).toBe('nextjs');
    expect(result.category).toBe('framework');
  });

  // ─── Cookie detection ─────────────────────────────────────────────

  it('Shopify: _shopify_ cookie detected via detectWithContext', () => {
    const html = '<html><body><p>Content</p></body></html>';
    const result = detector.detectWithContext(html, {
      cookies: ['_shopify_s=abc123; path=/'],
    });
    expect(result.platform).toBe('shopify');
    expect(result.category).toBe('ecommerce');
  });

  // ─── detect() and detectWithContext() parity ──────────────────────

  it('detect(html) and detectWithContext(html, {}) return identical results', () => {
    const html = `<html><head>
      <script src="https://cdn.shopify.com/s/files/1/theme.js"></script>
    </head><body><h1>Shop</h1></body></html>`;
    const r1 = detector.detect(html);
    const r2 = detector.detectWithContext(html, {});
    expect(r1.platform).toBe(r2.platform);
    expect(r1.category).toBe(r2.category);
    expect(r1.confidence).toBe(r2.confidence);
  });
});
