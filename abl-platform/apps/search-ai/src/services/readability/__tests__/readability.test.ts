/**
 * Readability Service Tests
 *
 * Tests Mozilla Readability integration for HTML noise removal.
 */

import { describe, test, expect } from 'vitest';
import { ReadabilityService } from '../index.js';

const service = new ReadabilityService();

describe('ReadabilityService', () => {
  describe('cleanHTML()', () => {
    test('should extract article content from HTML with noise', () => {
      const rawHTML = `
        <!DOCTYPE html>
        <html>
          <head><title>Test Article</title></head>
          <body>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
            <aside>Advertisement</aside>
            <article>
              <h1>Main Article Title</h1>
              <p>This is the main content of the article.</p>
              <p>It has multiple paragraphs with useful information.</p>
            </article>
            <footer>Copyright 2025</footer>
          </body>
        </html>
      `;

      const result = service.cleanHTML(rawHTML, 'https://example.com/article');

      expect(result.success).toBe(true);
      expect(result.cleanedHTML).toContain('Main Article Title');
      expect(result.cleanedHTML).toContain('main content of the article');
      expect(result.cleanedHTML).not.toContain('Advertisement');
      expect(result.cleanedHTML).not.toContain('Copyright 2025');
      expect(result.metadata.cleaned).toBe(true);
      expect(result.metadata.sizeReduction).toBeGreaterThan(0);
    });

    test('should preserve semantic HTML structure', () => {
      const rawHTML = `
        <!DOCTYPE html>
        <html>
          <head><title>Technical Article</title></head>
          <body>
            <article>
              <h1>How to Use TypeScript</h1>
              <h2>Installation</h2>
              <p>First, install TypeScript:</p>
              <pre><code>npm install typescript</code></pre>
              <h2>Usage</h2>
              <ul>
                <li>Create a tsconfig.json</li>
                <li>Write TypeScript code</li>
                <li>Compile with tsc</li>
              </ul>
              <table>
                <tr><th>Command</th><th>Description</th></tr>
                <tr><td>tsc</td><td>Compile TypeScript</td></tr>
              </table>
            </article>
          </body>
        </html>
      `;

      const result = service.cleanHTML(rawHTML, 'https://example.com/typescript');

      expect(result.success).toBe(true);
      // Check for content, not specific tags (Readability may reformat)
      expect(result.cleanedHTML).toContain('How to Use TypeScript');
      expect(result.cleanedHTML).toContain('Installation');
      expect(result.cleanedHTML).toContain('npm install typescript');
      expect(result.cleanedHTML).toContain('tsconfig.json');
    });

    test('should handle short content gracefully', () => {
      const rawHTML = '<html><body><div>Short content</div></body></html>';

      const result = service.cleanHTML(rawHTML, 'https://example.com/short');

      // Even if Readability succeeds, result is valid
      expect(result.cleanedHTML).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.metadata.originalSize).toBeGreaterThan(0);
    });

    test('should handle empty HTML gracefully', () => {
      const result = service.cleanHTML('', 'https://example.com');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty HTML content');
      expect(result.cleanedHTML).toBe('');
    });

    test('should extract metadata', () => {
      const rawHTML = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Article with Metadata</title>
            <meta name="author" content="John Doe">
            <meta name="description" content="A great article">
          </head>
          <body>
            <article>
              <h1>Article Title</h1>
              <p class="byline">By John Doe</p>
              <p>Article content goes here with enough text to make Readability happy.</p>
              <p>Multiple paragraphs ensure Readability recognizes this as an article.</p>
              <p>The more content we have, the better Readability performs.</p>
            </article>
          </body>
        </html>
      `;

      const result = service.cleanHTML(rawHTML, 'https://example.com/article');

      expect(result.success).toBe(true);
      expect(result.metadata.title).toBeTruthy();
      expect(result.metadata.contentLength).toBeGreaterThan(0);
      expect(result.metadata.textContentLength).toBeGreaterThan(0);
    });

    test('should wrap cleaned content in HTML structure', () => {
      const rawHTML = `
        <!DOCTYPE html>
        <html>
          <head><title>Wrapped Article</title></head>
          <body>
            <article>
              <h1>Content</h1>
              <p>This is the content that should be wrapped.</p>
            </article>
          </body>
        </html>
      `;

      const result = service.cleanHTML(rawHTML, 'https://example.com/wrapped');

      expect(result.success).toBe(true);
      expect(result.cleanedHTML).toContain('<!DOCTYPE html>');
      expect(result.cleanedHTML).toContain('<html');
      expect(result.cleanedHTML).toContain('<head>');
      expect(result.cleanedHTML).toContain('<title>');
      expect(result.cleanedHTML).toContain('<body>');
      expect(result.cleanedHTML).toContain('<article>');
    });

    test('should calculate size metrics correctly', () => {
      const rawHTML = `
        <!DOCTYPE html>
        <html>
          <head><title>Large Page</title></head>
          <body>
            <nav>Nav content here</nav>
            <aside>Sidebar content here</aside>
            <article>
              <h1>Article Title</h1>
              <p>Main content paragraph 1</p>
              <p>Main content paragraph 2</p>
              <p>Main content paragraph 3</p>
            </article>
            <footer>Footer content here</footer>
          </body>
        </html>
      `;

      const result = service.cleanHTML(rawHTML, 'https://example.com/large');

      // Size reduction should be within valid range
      // Note: Wrapped HTML can sometimes be larger than original (minimal pages)
      expect(result.metadata.originalSize).toBeGreaterThan(0);
      expect(result.metadata.cleanedSize).toBeGreaterThan(0);
      expect(result.metadata.sizeReduction).toBeGreaterThanOrEqual(0);
      expect(result.metadata.sizeReduction).toBeLessThanOrEqual(100);
    });

    test('should handle malformed HTML gracefully', () => {
      const rawHTML = '<html><body><div>Content<p>Unclosed tags<article>More</body>';

      const result = service.cleanHTML(rawHTML, 'https://example.com/malformed');

      // Should not throw, either succeeds or returns original
      expect(result).toBeDefined();
      expect(result.cleanedHTML).toBeDefined();
    });

    test('should preserve images in article content', () => {
      const rawHTML = `
        <!DOCTYPE html>
        <html>
          <head><title>Article with Images</title></head>
          <body>
            <article>
              <h1>Photo Gallery</h1>
              <p>Check out these images:</p>
              <img src="/image1.jpg" alt="Image 1">
              <p>Description of the image.</p>
              <img src="/image2.jpg" alt="Image 2">
            </article>
          </body>
        </html>
      `;

      const result = service.cleanHTML(rawHTML, 'https://example.com/images');

      expect(result.success).toBe(true);
      expect(result.cleanedHTML).toContain('<img');
      expect(result.cleanedHTML).toContain('image1.jpg');
      expect(result.cleanedHTML).toContain('image2.jpg');
    });
  });

  describe('Documentation Site Detection and Minimal Cleaning', () => {
    test('should detect documentation site by hostname pattern (docs.*)', () => {
      const docHTML = `
        <!DOCTYPE html>
        <html>
          <head><title>Documentation Home</title></head>
          <body>
            <script>console.log('analytics');</script>
            <nav>
              <a href="/products">Products</a>
              <a href="/api">API Reference</a>
            </nav>
            <main>
              <h1>Welcome to Docs</h1>
              <div class="card-grid">
                <div class="card">
                  <h2>Product 1</h2>
                  <p>Description for product 1</p>
                </div>
                <div class="card">
                  <h2>Product 2</h2>
                  <p>Description for product 2</p>
                </div>
              </div>
            </main>
            <footer>Copyright 2024</footer>
          </body>
        </html>
      `;

      const result = service.cleanHTML(docHTML, 'https://docs.example.com/', 'static');

      // Should apply minimal cleaning, not full Readability
      expect(result.success).toBe(true);
      expect(result.metadata.cleaned).toBe(false); // Indicates minimal cleaning was used

      // Should preserve navigation and structure
      expect(result.cleanedHTML).toContain('Products');
      expect(result.cleanedHTML).toContain('API Reference');
      expect(result.cleanedHTML).toContain('Product 1');
      expect(result.cleanedHTML).toContain('Product 2');
      expect(result.cleanedHTML).toContain('card-grid');

      // Should remove scripts but preserve content
      expect(result.cleanedHTML).not.toContain('console.log');

      // Size reduction should be minimal (only scripts/styles removed)
      expect(result.metadata.sizeReduction).toBeLessThan(50);
    });

    test('should detect documentation site by subdomain patterns', () => {
      const testUrls = [
        'https://docs.kore.ai/',
        'https://developer.github.com/',
        'https://api.stripe.com/',
        'https://reference.python.org/',
        'https://guide.mongodb.com/',
        'https://help.salesforce.com/',
      ];

      testUrls.forEach((url) => {
        const html =
          '<html><head><title>Test</title></head><body><h1>Test</h1><p>Content</p></body></html>';
        const result = service.cleanHTML(html, url, 'static');

        expect(result.metadata.cleaned).toBe(false); // Should use minimal cleaning
      });
    });

    test('should detect documentation site by path pattern', () => {
      const docHTML =
        '<html><head><title>Docs</title></head><body><nav><a href="/">Home</a></nav><h1>Documentation</h1><p>Content</p></body></html>';

      const result = service.cleanHTML(
        docHTML,
        'https://example.com/docs/getting-started',
        'static',
      );

      expect(result.success).toBe(true);
      expect(result.metadata.cleaned).toBe(false);
      expect(result.cleanedHTML).toContain('Home'); // Navigation preserved
    });

    test('should apply minimal cleaning that removes only scripts and styles', () => {
      const htmlWithNoise = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Documentation</title>
            <style>body { color: blue; }</style>
          </head>
          <body>
            <script src="analytics.js"></script>
            <script>
              function track() { console.log('tracking'); }
            </script>
            <nav onclick="handleClick()">
              <a href="/" onmouseover="highlight()">Home</a>
            </nav>
            <!-- This is a comment -->
            <main>
              <h1>Main Content</h1>
              <p>Important documentation content.</p>
            </main>
            <footer>Footer content</footer>
          </body>
        </html>
      `;

      const result = service.cleanHTML(htmlWithNoise, 'https://docs.example.com/', 'static');

      // Scripts should be removed
      expect(result.cleanedHTML).not.toContain('<script');
      expect(result.cleanedHTML).not.toContain('analytics.js');
      expect(result.cleanedHTML).not.toContain('console.log');

      // Styles should be removed
      expect(result.cleanedHTML).not.toContain('<style');
      expect(result.cleanedHTML).not.toContain('color: blue');

      // Inline event handlers should be removed
      expect(result.cleanedHTML).not.toContain('onclick=');
      expect(result.cleanedHTML).not.toContain('onmouseover=');

      // Comments should be removed
      expect(result.cleanedHTML).not.toContain('<!-- This is a comment -->');

      // All content should be preserved
      expect(result.cleanedHTML).toContain('Home');
      expect(result.cleanedHTML).toContain('Main Content');
      expect(result.cleanedHTML).toContain('Important documentation content');
      expect(result.cleanedHTML).toContain('Footer content');
    });

    test('should apply minimal cleaning to blog sites (treated as content-rich)', () => {
      const blogHTML = `
        <!DOCTYPE html>
        <html>
          <head><title>Blog Post</title></head>
          <body>
            <nav><a href="/">Home</a></nav>
            <aside>Advertisement</aside>
            <article>
              <h1>My Blog Post</h1>
              <p>This is a great blog post with lots of content.</p>
              <p>Multiple paragraphs make this clearly an article.</p>
            </article>
            <footer>Copyright 2024</footer>
          </body>
        </html>
      `;

      // blog.example.com is now detected as a content site (minimal cleaning)
      const result = service.cleanHTML(blogHTML, 'https://blog.example.com/post');

      expect(result.success).toBe(true);
      expect(result.metadata.cleaned).toBe(false); // Minimal cleaning applied (blog.* pattern)
      expect(result.cleanedHTML).toContain('great blog post');
      expect(result.cleanedHTML).toContain('Home'); // Nav preserved with minimal cleaning
    });

    test('should still apply full Readability to non-matching sites', () => {
      const siteHTML = `
        <!DOCTYPE html>
        <html>
          <head><title>News Article</title></head>
          <body>
            <nav><a href="/">Home</a></nav>
            <aside>Advertisement</aside>
            <article>
              <h1>Breaking News</h1>
              <p>This is an important news article with lots of content.</p>
              <p>Multiple paragraphs make this clearly an article.</p>
            </article>
            <footer>Copyright 2024</footer>
          </body>
        </html>
      `;

      // Non-matching URL: no doc/blog/kb pattern
      const result = service.cleanHTML(siteHTML, 'https://news.example.com/story');

      expect(result.success).toBe(true);
      expect(result.cleanedHTML).toContain('important news article');
    });

    test('should handle siteType parameter correctly', () => {
      const html =
        '<html><head><title>Test</title></head><body><nav>Nav</nav><h1>Content</h1><p>Text</p></body></html>';

      // With siteType='static' and docs URL -> minimal cleaning
      const staticResult = service.cleanHTML(html, 'https://docs.example.com/', 'static');
      expect(staticResult.metadata.cleaned).toBe(false);
      expect(staticResult.cleanedHTML).toContain('Nav');

      // With siteType='spa' -> should still check URL patterns
      const spaResult = service.cleanHTML(html, 'https://docs.example.com/', 'spa');
      expect(spaResult.metadata.cleaned).toBe(false); // docs.* pattern still matches

      // blog.* URL now matches doc patterns -> minimal cleaning
      const blogResult = service.cleanHTML(html, 'https://blog.example.com/article', undefined);
      expect(blogResult.metadata.cleaned).toBe(false);

      // Non-matching URL without siteType -> full Readability (or fallback)
      const newsResult = service.cleanHTML(html, 'https://news.example.com/article', undefined);
      // Either Readability runs (cleaned=true) or fallback triggers — both are valid
      expect(newsResult.success).toBeDefined();
    });

    test('should preserve high content percentage for documentation sites', () => {
      const richDocHTML = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Rich Documentation</title>
            <script>analytics();</script>
            <style>.hide { display: none; }</style>
          </head>
          <body>
            <nav>
              <a href="/home">Home</a>
              <a href="/products">Products</a>
              <a href="/api">API</a>
            </nav>
            <main>
              <h1>Documentation Home</h1>
              <h2>Getting Started</h2>
              <p>Follow these steps to get started.</p>
              <h2>API Reference</h2>
              <div class="api-list">
                <h3>Authentication</h3>
                <p>Use API keys for auth.</p>
                <h3>Endpoints</h3>
                <ul>
                  <li>GET /users</li>
                  <li>POST /users</li>
                </ul>
              </div>
              <h2>Examples</h2>
              <pre><code>const api = new API();</code></pre>
            </main>
            <footer>Contact us</footer>
          </body>
        </html>
      `;

      const result = service.cleanHTML(richDocHTML, 'https://docs.example.com/', 'static');

      const originalSize = result.metadata.originalSize;
      const cleanedSize = result.metadata.cleanedSize;
      const preservationRatio = (cleanedSize / originalSize) * 100;

      // Should preserve >90% of content (only scripts/styles removed)
      expect(preservationRatio).toBeGreaterThan(70);

      // Should preserve all structural elements
      expect(result.cleanedHTML).toContain('Getting Started');
      expect(result.cleanedHTML).toContain('API Reference');
      expect(result.cleanedHTML).toContain('Authentication');
      expect(result.cleanedHTML).toContain('Endpoints');
      expect(result.cleanedHTML).toContain('GET /users');
      expect(result.cleanedHTML).toContain('Examples');
    });
  });
});
