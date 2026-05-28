/**
 * Quality Metrics Service Tests
 *
 * Tests quality analysis and reporting functionality.
 */

import { describe, test, expect } from 'vitest';
import { QualityMetricsService } from '../index.js';

describe('QualityMetricsService', () => {
  const service = new QualityMetricsService();

  // Sample HTML for testing
  const rawHTML = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Test Article</title>
        <script>console.log('analytics');</script>
        <style>.ad { display: block; }</style>
      </head>
      <body>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
        </nav>
        <aside>
          <div class="ad">Advertisement</div>
        </aside>
        <main>
          <h1>Main Article Title</h1>
          <p>This is the main content of the article with useful information.</p>
          <h2>Section Heading</h2>
          <p>More content here with <a href="/link">a link</a>.</p>
          <img src="/image.jpg" alt="Image" />
          <table>
            <tr><td>Data</td></tr>
          </table>
        </main>
        <footer>
          <p>Copyright 2025</p>
        </footer>
        <script>trackEvent('pageview');</script>
      </body>
    </html>
  `;

  const cleanedHTML = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Test Article</title>
      </head>
      <body>
        <main>
          <h1>Main Article Title</h1>
          <p>This is the main content of the article with useful information.</p>
          <h2>Section Heading</h2>
          <p>More content here with <a href="/link">a link</a>.</p>
          <img src="/image.jpg" alt="Image" />
          <table>
            <tr><td>Data</td></tr>
          </table>
        </main>
      </body>
    </html>
  `;

  describe('analyzeQuality', () => {
    test('should calculate size metrics correctly', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com/article',
        rawHTML,
        cleanedHTML,
      );

      expect(metrics.size.rawBytes).toBeGreaterThan(0);
      expect(metrics.size.cleanedBytes).toBeGreaterThan(0);
      expect(metrics.size.rawBytes).toBeGreaterThan(metrics.size.cleanedBytes);
      expect(metrics.size.reductionPercent).toBeGreaterThan(0);
      expect(metrics.size.reductionPercent).toBeLessThanOrEqual(100);
    });

    test('should calculate content preservation', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com/article',
        rawHTML,
        cleanedHTML,
      );

      expect(metrics.content.rawTextLength).toBeGreaterThan(0);
      expect(metrics.content.cleanedTextLength).toBeGreaterThan(0);
      expect(metrics.content.contentPreservationPercent).toBeGreaterThan(0);
      expect(metrics.content.contentPreservationPercent).toBeLessThanOrEqual(100);
    });

    test('should analyze structure preservation', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com/article',
        rawHTML,
        cleanedHTML,
      );

      expect(metrics.structure.headingsRaw).toBe(2); // h1 + h2
      expect(metrics.structure.headingsCleaned).toBe(2);
      expect(metrics.structure.headingsPreservedPercent).toBe(100);

      expect(metrics.structure.linksRaw).toBeGreaterThanOrEqual(1);
      expect(metrics.structure.linksCleaned).toBeGreaterThanOrEqual(1);

      expect(metrics.structure.imagesRaw).toBe(1);
      expect(metrics.structure.imagesCleaned).toBe(1);

      expect(metrics.structure.tablesRaw).toBe(1);
      expect(metrics.structure.tablesCleaned).toBe(1);
    });

    test('should analyze noise removal', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com/article',
        rawHTML,
        cleanedHTML,
      );

      expect(metrics.noise.navElementsRemoved).toBe(1);
      expect(metrics.noise.asideElementsRemoved).toBe(1);
      expect(metrics.noise.footerElementsRemoved).toBe(1);
      // Cleaned HTML in test already has scripts/styles removed
      expect(metrics.noise.scriptTagsRemoved).toBe(0);
      expect(metrics.noise.styleTagsRemoved).toBe(0);
      expect(metrics.noise.estimatedNoisePercent).toBeGreaterThan(0);
    });

    test('should analyze metadata extraction', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com/article',
        rawHTML,
        cleanedHTML,
        {
          title: 'Test Article',
          author: 'John Doe',
          excerpt: 'Article summary',
        },
      );

      expect(metrics.metadata.titleExtracted).toBe(true);
      expect(metrics.metadata.authorExtracted).toBe(true);
      expect(metrics.metadata.excerptExtracted).toBe(true);
      expect(metrics.metadata.titleMatch).toBe(true);
    });

    test('should calculate quality scores', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com/article',
        rawHTML,
        cleanedHTML,
        {
          title: 'Test Article',
          author: 'John Doe',
        },
      );

      expect(metrics.scores.overall).toBeGreaterThan(0);
      expect(metrics.scores.overall).toBeLessThanOrEqual(100);

      expect(metrics.scores.noiseReduction).toBeGreaterThan(0);
      expect(metrics.scores.noiseReduction).toBeLessThanOrEqual(100);

      expect(metrics.scores.contentPreservation).toBeGreaterThan(0);
      expect(metrics.scores.contentPreservation).toBeLessThanOrEqual(100);

      expect(metrics.scores.structurePreservation).toBeGreaterThan(0);
      expect(metrics.scores.structurePreservation).toBeLessThanOrEqual(100);

      expect(metrics.scores.metadataExtraction).toBeGreaterThan(0);
      expect(metrics.scores.metadataExtraction).toBeLessThanOrEqual(100);
    });

    test('should handle missing metadata gracefully', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com/article',
        rawHTML,
        cleanedHTML,
      );

      expect(metrics.metadata.titleExtracted).toBe(false);
      expect(metrics.metadata.authorExtracted).toBe(false);
      expect(metrics.metadata.excerptExtracted).toBe(false);
      expect(metrics.metadata.titleMatch).toBe(false);
      expect(metrics.scores.metadataExtraction).toBe(0);
    });

    test('should handle HTML without headings', () => {
      const simpleHTML = '<html><body><p>Content</p></body></html>';
      const metrics = service.analyzeQuality('doc1', 'https://example.com', simpleHTML, simpleHTML);

      expect(metrics.structure.headingsRaw).toBe(0);
      expect(metrics.structure.headingsCleaned).toBe(0);
      expect(metrics.structure.headingsPreservedPercent).toBe(100); // Default when no headings
    });

    test('should include document metadata', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com/article',
        rawHTML,
        cleanedHTML,
      );

      expect(metrics.documentId).toBe('doc1');
      expect(metrics.url).toBe('https://example.com/article');
      expect(metrics.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('generateReport', () => {
    test('should aggregate metrics from multiple documents', () => {
      const metrics1 = service.analyzeQuality(
        'doc1',
        'https://example.com/1',
        rawHTML,
        cleanedHTML,
      );
      const metrics2 = service.analyzeQuality(
        'doc2',
        'https://example.com/2',
        rawHTML,
        cleanedHTML,
      );
      const metrics3 = service.analyzeQuality(
        'doc3',
        'https://example.com/3',
        rawHTML,
        cleanedHTML,
      );

      const report = service.generateReport([metrics1, metrics2, metrics3]);

      expect(report.totalDocuments).toBe(3);
      expect(report.aggregate.avgSizeReduction).toBeGreaterThan(0);
      expect(report.aggregate.avgContentPreservation).toBeGreaterThan(0);
      expect(report.aggregate.avgNoiseReduction).toBeGreaterThan(0);
      expect(report.aggregate.avgOverallScore).toBeGreaterThan(0);
    });

    test('should calculate score distribution', () => {
      // Create metrics with different quality scores
      const goodHTML = cleanedHTML; // Should score reasonably well
      const simpleHTML = '<html><body><p>Simple content here.</p></body></html>';

      const metrics1 = service.analyzeQuality('doc1', 'https://example.com/1', rawHTML, goodHTML, {
        title: 'Article',
        author: 'Author',
        excerpt: 'Excerpt',
      });
      const metrics2 = service.analyzeQuality(
        'doc2',
        'https://example.com/2',
        simpleHTML,
        simpleHTML,
      );

      const report = service.generateReport([metrics1, metrics2]);

      // Verify distribution buckets exist
      expect(report.distribution.excellent).toBeGreaterThanOrEqual(0);
      expect(report.distribution.good).toBeGreaterThanOrEqual(0);
      expect(report.distribution.fair).toBeGreaterThanOrEqual(0);
      expect(report.distribution.poor).toBeGreaterThanOrEqual(0);

      // Total should equal number of documents
      const total =
        report.distribution.excellent +
        report.distribution.good +
        report.distribution.fair +
        report.distribution.poor;
      expect(total).toBe(report.totalDocuments);
      expect(total).toBe(2);
    });

    test('should include time period', () => {
      const metrics1 = service.analyzeQuality(
        'doc1',
        'https://example.com/1',
        rawHTML,
        cleanedHTML,
      );
      // Add small delay
      const metrics2 = service.analyzeQuality(
        'doc2',
        'https://example.com/2',
        rawHTML,
        cleanedHTML,
      );

      const report = service.generateReport([metrics1, metrics2]);

      expect(report.period.start).toBeInstanceOf(Date);
      expect(report.period.end).toBeInstanceOf(Date);
      expect(report.period.start.getTime()).toBeLessThanOrEqual(report.period.end.getTime());
    });

    test('should throw error for empty metrics array', () => {
      expect(() => service.generateReport([])).toThrow('Cannot generate report with zero metrics');
    });

    test('should include all individual metrics', () => {
      const metrics1 = service.analyzeQuality(
        'doc1',
        'https://example.com/1',
        rawHTML,
        cleanedHTML,
      );
      const metrics2 = service.analyzeQuality(
        'doc2',
        'https://example.com/2',
        rawHTML,
        cleanedHTML,
      );

      const report = service.generateReport([metrics1, metrics2]);

      expect(report.metrics).toHaveLength(2);
      expect(report.metrics[0]).toEqual(metrics1);
      expect(report.metrics[1]).toEqual(metrics2);
    });
  });

  describe('fuzzy matching', () => {
    test('should match identical titles', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com',
        '<html><head><title>Test Article</title></head><body><p>Content</p></body></html>',
        '<html><body><p>Content</p></body></html>',
        { title: 'Test Article' },
      );

      expect(metrics.metadata.titleMatch).toBe(true);
    });

    test('should match case-insensitive titles', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com',
        '<html><head><title>Test Article</title></head><body><p>Content</p></body></html>',
        '<html><body><p>Content</p></body></html>',
        { title: 'test article' },
      );

      expect(metrics.metadata.titleMatch).toBe(true);
    });

    test('should match titles with different punctuation', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com',
        '<html><head><title>Test Article!</title></head><body><p>Content</p></body></html>',
        '<html><body><p>Content</p></body></html>',
        { title: 'Test Article' },
      );

      expect(metrics.metadata.titleMatch).toBe(true);
    });

    test('should match when one title contains the other', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com',
        '<html><head><title>Test Article - Example Site</title></head><body><p>Content</p></body></html>',
        '<html><body><p>Content</p></body></html>',
        { title: 'Test Article' },
      );

      expect(metrics.metadata.titleMatch).toBe(true);
    });

    test('should not match completely different titles', () => {
      const metrics = service.analyzeQuality(
        'doc1',
        'https://example.com',
        '<html><head><title>Original Title</title></head><body><p>Content</p></body></html>',
        '<html><body><p>Content</p></body></html>',
        { title: 'Completely Different' },
      );

      expect(metrics.metadata.titleMatch).toBe(false);
    });
  });
});
