/**
 * Multi-Modal Enrichment Tests
 *
 * Tests for utility methods and service availability.
 * LLM-dependent tests removed (mock-echo pattern).
 */

import { describe, it, expect, vi } from 'vitest';
import { MultiModalEnricher, type TableData } from '../services/multimodal/index.js';

vi.mock('@agent-platform/llm', () => ({
  WorkerLLMClient: class MockWorkerLLMClient {
    constructor() {}
    chat = vi.fn().mockResolvedValue('Mocked LLM response');
  },
}));

describe('MultiModalEnricher', () => {
  const mockConfig = {
    enabled: true,
    visionProvider: 'openai' as const,
    visionApiKey: 'test-key',
    visionModel: 'gpt-4-vision-preview',
    tableSummarizerProvider: 'google' as const,
    tableSummarizerApiKey: 'test-key',
    tableSummarizerModel: 'gemini-1.5-flash',
    enableImageDescription: true,
    enableTableSummarization: true,
    enableChartAnalysis: true,
    maxImageSizeBytes: 20_971_520,
    maxTableSizeBytes: 102_400,
    rateLimitPerMinute: 60,
  };

  type MultiModalEnricherInternals = {
    formatTableContent(table: TableData): string;
    truncateCsv(csv: string, maxSize: number): string;
    truncateHtml(html: string, maxSize: number): string;
  };

  const getInternals = (enricher: MultiModalEnricher): MultiModalEnricherInternals =>
    enricher as unknown as MultiModalEnricherInternals;

  const createEnricher = (overrides: Partial<typeof mockConfig> = {}): MultiModalEnricher =>
    new MultiModalEnricher({ ...mockConfig, ...overrides });

  describe('Utility Methods', () => {
    it('should extract tables from HTML', () => {
      const html = `
        <div>
          <table id="t1"><tr><td>Data 1</td></tr></table>
          <p>Some text</p>
          <table id="t2"><tr><td>Data 2</td></tr></table>
        </div>
      `;

      const tables = MultiModalEnricher.extractTablesFromHtml(html);

      expect(tables).toHaveLength(2);
      expect(tables[0]).toContain('Data 1');
      expect(tables[1]).toContain('Data 2');
    });

    it('should extract images from HTML', () => {
      const html = `
        <div>
          <img src="image1.png" alt="First image" />
          <p>Text</p>
          <img src="https://example.com/image2.jpg" />
        </div>
      `;

      const images = MultiModalEnricher.extractImagesFromHtml(html);

      expect(images).toHaveLength(2);
      expect(images[0].src).toBe('image1.png');
      expect(images[0].alt).toBe('First image');
      expect(images[1].src).toBe('https://example.com/image2.jpg');
    });

    it('should detect table metadata', () => {
      const csvContent = 'Col1,Col2,Col3\nRow1,Data1,Val1\nRow2,Data2,Val2\n';

      const metadata = MultiModalEnricher.detectTableMetadata(csvContent, 'csv');

      expect(metadata.rowCount).toBe(2); // Excludes header
      expect(metadata.columnCount).toBe(3);
    });

    it('should detect table metadata for HTML tables', () => {
      const htmlContent = `
        <table>
          <thead>
            <tr><th>Name</th><th>Score</th></tr>
          </thead>
          <tbody>
            <tr><td>Alice</td><td>98</td></tr>
            <tr><td>Bob</td><td>95</td></tr>
          </tbody>
        </table>
      `;

      const metadata = MultiModalEnricher.detectTableMetadata(htmlContent, 'html');

      expect(metadata.rowCount).toBe(3);
      expect(metadata.columnCount).toBe(2);
    });
  });

  describe('Table Formatting', () => {
    it('should return table content unchanged when it is already within the size limit', () => {
      const enricher = createEnricher({ maxTableSizeBytes: 1_024 });
      const table: TableData = {
        content: 'name,score\nAlice,98\nBob,95\n',
        format: 'csv',
      };

      const formatted = getInternals(enricher).formatTableContent(table);

      expect(formatted).toBe(table.content);
    });

    it('should truncate oversized JSON tables with a truncation marker', () => {
      const jsonTable = JSON.stringify({
        rows: [
          { name: 'Alice', score: 98 },
          { name: 'Bob', score: 95 },
        ],
      });
      const maxTableSizeBytes = Buffer.byteLength('{"rows":[{"name":"Ali', 'utf-8');
      const enricher = createEnricher({ maxTableSizeBytes });

      const formatted = getInternals(enricher).formatTableContent({
        content: jsonTable,
        format: 'json',
      });

      expect(formatted).toBe(jsonTable.slice(0, maxTableSizeBytes) + '\n... [truncated]');
    });

    it('should truncate CSV tables at row boundaries while preserving the header', () => {
      const csvContent = `id
1
${'x'.repeat(40)}
`;
      const expectedTruncated = 'id\n1\n... [truncated]\n';
      const maxSize = Buffer.byteLength(expectedTruncated, 'utf-8');
      const enricher = createEnricher({ maxTableSizeBytes: maxSize });
      const internals = getInternals(enricher);

      const truncated = internals.truncateCsv(csvContent, maxSize);
      const formatted = internals.formatTableContent({
        content: csvContent,
        format: 'csv',
      });

      expect(truncated).toBe(expectedTruncated);
      expect(formatted).toBe(expectedTruncated);
      expect(Buffer.byteLength(truncated, 'utf-8')).toBeLessThanOrEqual(maxSize);
      expect(truncated).not.toContain('x'.repeat(40));
    });

    it('should truncate HTML tables at row boundaries and keep the table closed', () => {
      const htmlContent = `<table><tbody><tr><td>1</td></tr><tr><td>${'x'.repeat(
        120,
      )}</td></tr></tbody></table>`;
      const expectedTruncated = '<table><tbody><tr><td>1</td></tr>... [truncated]</tbody></table>';
      const maxSize = Buffer.byteLength(expectedTruncated, 'utf-8');
      const enricher = createEnricher({ maxTableSizeBytes: maxSize });
      const internals = getInternals(enricher);

      const truncated = internals.truncateHtml(htmlContent, maxSize);
      const formatted = internals.formatTableContent({
        content: htmlContent,
        format: 'html',
      });

      expect(truncated).toBe(expectedTruncated);
      expect(formatted).toBe(expectedTruncated);
      expect(Buffer.byteLength(truncated, 'utf-8')).toBeLessThanOrEqual(maxSize);
      expect(truncated).not.toContain('x'.repeat(120));
    });
  });

  describe('Service Status', () => {
    it('should handle missing API keys gracefully', () => {
      const configWithoutKeys = {
        ...mockConfig,
        visionApiKey: undefined,
        tableSummarizerApiKey: undefined,
      };

      const enricher = new MultiModalEnricher(configWithoutKeys);

      const isAvailable = enricher.isAvailable();

      // Should not be available without API keys
      expect(isAvailable).toBe(false);
      expect(enricher.getStatus()).toEqual({
        visionEnabled: false,
        tableSummarizerEnabled: false,
        visionProvider: undefined,
        tableSummarizerProvider: undefined,
      });
    });

    it('should be available when only the vision client is configured', () => {
      const enricher = new MultiModalEnricher({
        ...mockConfig,
        tableSummarizerApiKey: undefined,
      });

      expect(enricher.isAvailable()).toBe(true);
      expect(enricher.getStatus()).toEqual({
        visionEnabled: true,
        tableSummarizerEnabled: false,
        visionProvider: 'openai',
        tableSummarizerProvider: undefined,
      });
    });

    it('should be available when only the table summarizer is configured', () => {
      const enricher = new MultiModalEnricher({
        ...mockConfig,
        visionApiKey: undefined,
      });

      expect(enricher.isAvailable()).toBe(true);
      expect(enricher.getStatus()).toEqual({
        visionEnabled: false,
        tableSummarizerEnabled: true,
        visionProvider: undefined,
        tableSummarizerProvider: 'google',
      });
    });

    it('should report both providers when both clients are configured', () => {
      const enricher = createEnricher();

      expect(enricher.isAvailable()).toBe(true);
      expect(enricher.getStatus()).toEqual({
        visionEnabled: true,
        tableSummarizerEnabled: true,
        visionProvider: 'openai',
        tableSummarizerProvider: 'google',
      });
    });
  });
});
