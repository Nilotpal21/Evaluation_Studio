import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { JsonLdExtractor } from '../../intelligence/algorithms/jsonld-extractor.js';

describe('JsonLdExtractor', () => {
  const extractor = new JsonLdExtractor();

  // ─── Product JSON-LD Tests ─────────────────────────────────────

  describe('Product extraction', () => {
    it('AC-1: Product page with full JSON-LD → found=true, primaryType=Product, canSkipLlm=true', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Widget Pro",
            "price": "29.99",
            "description": "The best widget ever made",
            "image": "https://example.com/widget.jpg",
            "sku": "WP-001",
            "brand": "WidgetCo"
          }
          </script>
        </head><body><h1>Widget Pro</h1></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('Product');
      expect(result.canSkipLlm).toBe(true);
      expect(result.extractedFields['name']).toBe('Widget Pro');
      expect(result.extractedFields['price']).toBe('29.99');
      expect(result.extractedFields['description']).toBe('The best widget ever made');
      expect(result.schemas).toHaveLength(1);
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  // ─── Article JSON-LD Tests ─────────────────────────────────────

  describe('Article extraction', () => {
    it('AC-4: Article with headline + author + date → canSkipLlm=true', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": "Breaking News: AI Takes Over",
            "author": "Jane Reporter",
            "datePublished": "2026-01-15",
            "description": "A detailed analysis of AI trends"
          }
          </script>
        </head><body><article>Content here</article></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('Article');
      expect(result.canSkipLlm).toBe(true);
      expect(result.extractedFields['headline']).toBe('Breaking News: AI Takes Over');
      expect(result.extractedFields['author']).toBe('Jane Reporter');
      expect(result.extractedFields['datePublished']).toBe('2026-01-15');
    });
  });

  // ─── Recipe JSON-LD Tests ──────────────────────────────────────

  describe('Recipe extraction', () => {
    it('Recipe with name + ingredients → found=true, primaryType=Recipe', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Recipe",
            "name": "Chocolate Cake",
            "ingredients": ["flour", "sugar", "cocoa"],
            "instructions": "Mix and bake at 350F for 30 minutes"
          }
          </script>
        </head><body><h1>Chocolate Cake Recipe</h1></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('Recipe');
      expect(result.canSkipLlm).toBe(true);
      expect(result.extractedFields['name']).toBe('Chocolate Cake');
      expect(result.extractedFields['ingredients']).toEqual(['flour', 'sugar', 'cocoa']);
    });
  });

  // ─── No JSON-LD Tests ─────────────────────────────────────────

  describe('no JSON-LD', () => {
    it('AC-2: No <script type="application/ld+json"> → found=false, schemas=[]', () => {
      const html = `
        <html><head><title>Plain Page</title></head>
        <body><p>Just a normal page with no structured data</p></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(false);
      expect(result.schemas).toEqual([]);
      expect(result.primaryType).toBeUndefined();
      expect(result.extractedFields).toEqual({});
      expect(result.canSkipLlm).toBe(false);
      expect(result.confidence).toBe(0);
    });
  });

  // ─── Malformed JSON Tests ─────────────────────────────────────

  describe('malformed JSON', () => {
    it('AC-3: Malformed JSON in script tag → gracefully skipped, found=false', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          { this is not valid JSON at all!!!
          </script>
        </head><body><p>Content</p></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(false);
      expect(result.schemas).toEqual([]);
      expect(result.canSkipLlm).toBe(false);
    });
  });

  // ─── Multiple JSON-LD Blocks Tests ────────────────────────────

  describe('multiple JSON-LD blocks', () => {
    it('all schemas collected, primaryType from most specific', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "Acme Corp"
          }
          </script>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Widget",
            "price": "19.99",
            "description": "A fine widget"
          }
          </script>
        </head><body><h1>Widget</h1></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.schemas).toHaveLength(2);
      // Product is more specific than Organization
      expect(result.primaryType).toBe('Product');
      expect(result.extractedFields['name']).toBe('Widget');
    });
  });

  // ─── Nested @graph Tests ──────────────────────────────────────

  describe('nested @graph structure', () => {
    it('extracts schemas from @graph array correctly', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "WebSite",
                "name": "Example Site"
              },
              {
                "@type": "Article",
                "headline": "Great Article",
                "author": "John Smith",
                "datePublished": "2026-02-01",
                "description": "An insightful piece"
              }
            ]
          }
          </script>
        </head><body><article>Great Article</article></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.schemas).toHaveLength(2);
      expect(result.primaryType).toBe('Article');
      expect(result.extractedFields['headline']).toBe('Great Article');
      expect(result.canSkipLlm).toBe(true);
    });
  });

  // ─── canSkipLlm Threshold Tests ───────────────────────────────

  describe('canSkipLlm threshold', () => {
    it('2 fields with minFieldsForSkip=3 → canSkipLlm=false', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Widget",
            "price": "9.99"
          }
          </script>
        </head><body><h1>Widget</h1></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('Product');
      expect(Object.keys(result.extractedFields)).toHaveLength(2);
      expect(result.canSkipLlm).toBe(false);
    });
  });

  // ─── Empty Script Tag Tests ───────────────────────────────────

  describe('empty script tag', () => {
    it('empty script tag → found=false', () => {
      const html = `
        <html><head>
          <script type="application/ld+json"></script>
        </head><body><p>Content</p></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(false);
      expect(result.schemas).toEqual([]);
    });
  });

  // ─── Parity Test ──────────────────────────────────────────────

  describe('extract vs extractWithDom parity', () => {
    it('AC-5: extract(html) and extractWithDom($) return identical results', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Parity Widget",
            "price": "49.99",
            "description": "Testing parity between methods",
            "sku": "PW-100"
          }
          </script>
        </head><body><h1>Parity Widget</h1></body></html>
      `;

      const resultFromHtml = extractor.extract(html);
      const $ = cheerio.load(html);
      const resultFromDom = extractor.extractWithDom($);

      expect(resultFromHtml).toEqual(resultFromDom);
    });
  });

  // ─── Config Override Tests ────────────────────────────────────

  describe('config overrides', () => {
    it('custom targetTypes changes which types can skip LLM', () => {
      const customExtractor = new JsonLdExtractor({
        targetTypes: ['Organization'],
      });
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Widget",
            "price": "9.99",
            "description": "A widget"
          }
          </script>
        </head><body><p>Content</p></body></html>
      `;
      const result = customExtractor.extract(html);

      // Product is NOT in custom targetTypes, so canSkipLlm = false
      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('Product');
      expect(result.canSkipLlm).toBe(false);
    });

    it('custom minFieldsForSkip changes threshold', () => {
      const lenientExtractor = new JsonLdExtractor({ minFieldsForSkip: 1 });
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": "Single Field Article"
          }
          </script>
        </head><body><article>Content</article></body></html>
      `;
      const result = lenientExtractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.canSkipLlm).toBe(true); // 1 field >= minFieldsForSkip of 1
    });
  });

  // ─── FAQPage Tests ────────────────────────────────────────────

  describe('FAQPage extraction', () => {
    it('FAQPage with questions → extractedFields includes questions', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
              {
                "@type": "Question",
                "name": "What is a widget?",
                "acceptedAnswer": {
                  "@type": "Answer",
                  "text": "A widget is a small gadget."
                }
              },
              {
                "@type": "Question",
                "name": "How much does it cost?",
                "acceptedAnswer": {
                  "@type": "Answer",
                  "text": "It costs $9.99."
                }
              }
            ]
          }
          </script>
        </head><body><h1>FAQ</h1></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('FAQPage');
      expect(result.extractedFields['mainEntity']).toBeDefined();
      expect(Array.isArray(result.extractedFields['mainEntity'])).toBe(true);
      const mainEntity = result.extractedFields['mainEntity'] as Array<Record<string, unknown>>;
      expect(mainEntity).toHaveLength(2);
    });
  });

  // ─── Unknown @type Tests ──────────────────────────────────────

  describe('unknown @type', () => {
    it('Organization → found=true but canSkipLlm=false (not in targetTypes)', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "Acme Corp",
            "url": "https://acme.example.com",
            "logo": "https://acme.example.com/logo.png"
          }
          </script>
        </head><body><h1>Acme Corp</h1></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('Organization');
      expect(result.canSkipLlm).toBe(false);
    });
  });

  // ─── HowTo Tests ──────────────────────────────────────────────

  describe('HowTo extraction', () => {
    it('HowTo with name and steps → extractedFields populated', () => {
      // HowTo has only 2 extractable fields (name, step), so default
      // minFieldsForSkip=3 means canSkipLlm=false. Use lenient config.
      const lenientExtractor = new JsonLdExtractor({ minFieldsForSkip: 2 });
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "HowTo",
            "name": "How to Build a Widget",
            "step": [
              {"@type": "HowToStep", "text": "Gather materials"},
              {"@type": "HowToStep", "text": "Assemble parts"},
              {"@type": "HowToStep", "text": "Test the widget"}
            ]
          }
          </script>
        </head><body><h1>How to Build a Widget</h1></body></html>
      `;
      const result = lenientExtractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('HowTo');
      expect(result.extractedFields['name']).toBe('How to Build a Widget');
      expect(result.extractedFields['step']).toBeDefined();
      expect(result.canSkipLlm).toBe(true);
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────

  describe('edge cases', () => {
    it('JSON-LD block without @type is skipped', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          { "@context": "https://schema.org", "name": "No Type" }
          </script>
        </head><body><p>Content</p></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(false);
      expect(result.schemas).toEqual([]);
    });

    it('JSON-LD array at top level is handled', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          [
            { "@type": "Product", "name": "Widget A", "price": "10", "description": "First" },
            { "@type": "Product", "name": "Widget B", "price": "20", "description": "Second" }
          ]
          </script>
        </head><body><p>Products</p></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.schemas).toHaveLength(2);
    });

    it('Event type with enough fields → canSkipLlm=true', () => {
      const html = `
        <html><head>
          <script type="application/ld+json">
          {
            "@type": "Event",
            "name": "Tech Conference 2026",
            "startDate": "2026-06-15",
            "location": "Convention Center",
            "description": "Annual tech conference"
          }
          </script>
        </head><body><h1>Tech Conference</h1></body></html>
      `;
      const result = extractor.extract(html);

      expect(result.found).toBe(true);
      expect(result.primaryType).toBe('Event');
      expect(result.canSkipLlm).toBe(true);
      expect(result.extractedFields['startDate']).toBe('2026-06-15');
    });
  });
});
