/**
 * Unit tests for `normalizeAzureAnalyzeResult` (LLD §3 Phase 3 Task 3.6).
 *
 * Three Azure response variants:
 *   - Layout (text + tables)
 *   - Read (text only, line-based)
 *   - Document with paragraphs role-tagged as `sectionHeading`/`title`
 *
 * Tests assert the canonical `ExtractionEnvelope` mapping shape — page text,
 * table rows + markdown synthesis, headings, language pick (max confidence),
 * and contentType pass-through.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeAzureAnalyzeResult,
  type AzureAnalyzeResult,
} from '@abl/piece-azure-document-intelligence/normalize';

const SOURCE_URL = 'https://files.example.com/sample.pdf';

describe('normalizeAzureAnalyzeResult', () => {
  it('maps a Layout-model response with lines and tables', () => {
    const azureResult: AzureAnalyzeResult = {
      modelId: 'prebuilt-layout',
      apiVersion: '2024-11-30',
      pages: [
        {
          pageNumber: 1,
          lines: [{ content: 'Hello world' }, { content: 'Second line' }],
        },
      ],
      tables: [
        {
          rowCount: 2,
          columnCount: 2,
          cells: [
            { rowIndex: 0, columnIndex: 0, content: 'col-a' },
            { rowIndex: 0, columnIndex: 1, content: 'col-b' },
            { rowIndex: 1, columnIndex: 0, content: 'val-1' },
            { rowIndex: 1, columnIndex: 1, content: 'val-2' },
          ],
          boundingRegions: [{ pageNumber: 1 }],
        },
      ],
      languages: [{ locale: 'en', confidence: 0.97 }],
    };

    const envelope = normalizeAzureAnalyzeResult(azureResult, {
      sourceUrl: SOURCE_URL,
      contentType: 'application/pdf',
    });

    expect(envelope.provider).toBe('azure-document-intelligence');
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.contentType).toBe('application/pdf');
    expect(envelope.pages).toHaveLength(1);
    expect(envelope.pages[0]!.text).toBe('Hello world\nSecond line');
    expect(envelope.pages[0]!.tables).toHaveLength(1);
    expect(envelope.pages[0]!.tables[0]!.rows).toEqual([
      ['col-a', 'col-b'],
      ['val-1', 'val-2'],
    ]);
    expect(envelope.pages[0]!.tables[0]!.markdown).toContain('col-a | col-b');
    expect(envelope.metadata.pageCount).toBe(1);
    expect(envelope.metadata.language).toBe('en');
    expect(envelope.metadata.languageConfidence).toBeCloseTo(0.97);
  });

  it('falls back to paragraphs when page.lines is empty (Read-model with paragraphs)', () => {
    const azureResult: AzureAnalyzeResult = {
      modelId: 'prebuilt-read',
      pages: [{ pageNumber: 1, words: [{ content: 'Hi' }] }],
      paragraphs: [
        { content: 'Paragraph one body.', boundingRegions: [{ pageNumber: 1 }] },
        { content: 'Paragraph two body.', boundingRegions: [{ pageNumber: 1 }] },
      ],
    };

    const envelope = normalizeAzureAnalyzeResult(azureResult, {
      sourceUrl: SOURCE_URL,
      contentType: 'application/pdf',
    });

    expect(envelope.pages[0]!.text).toBe('Paragraph one body.\n\nParagraph two body.');
    expect(envelope.metadata.hasOCR).toBe(true);
  });

  it('lifts paragraphs with role=title/sectionHeading into ExtractionPage.headings', () => {
    const azureResult: AzureAnalyzeResult = {
      modelId: 'prebuilt-document',
      pages: [{ pageNumber: 1, lines: [{ content: 'body' }] }],
      paragraphs: [
        { role: 'title', content: 'Document Title', boundingRegions: [{ pageNumber: 1 }] },
        {
          role: 'sectionHeading',
          content: 'Section 1',
          boundingRegions: [{ pageNumber: 1 }],
        },
      ],
    };

    const envelope = normalizeAzureAnalyzeResult(azureResult, {
      sourceUrl: SOURCE_URL,
      contentType: 'application/pdf',
    });

    expect(envelope.pages[0]!.headings).toEqual([
      { level: 1, text: 'Document Title' },
      { level: 2, text: 'Section 1' },
    ]);
  });

  it('picks the highest-confidence language when multiple are detected', () => {
    const azureResult: AzureAnalyzeResult = {
      pages: [{ pageNumber: 1, lines: [{ content: 'mixed text' }] }],
      languages: [
        { locale: 'en', confidence: 0.62 },
        { locale: 'fr', confidence: 0.81 },
        { locale: 'es', confidence: 0.45 },
      ],
    };

    const envelope = normalizeAzureAnalyzeResult(azureResult, {
      sourceUrl: SOURCE_URL,
      contentType: 'application/pdf',
    });

    expect(envelope.metadata.language).toBe('fr');
    expect(envelope.metadata.languageConfidence).toBeCloseTo(0.81);
  });

  it('synthesizes markdown from page text when result.content is absent', () => {
    const azureResult: AzureAnalyzeResult = {
      pages: [
        { pageNumber: 1, lines: [{ content: 'first page' }] },
        { pageNumber: 2, lines: [{ content: 'second page' }] },
      ],
    };

    const envelope = normalizeAzureAnalyzeResult(azureResult, {
      sourceUrl: SOURCE_URL,
      contentType: 'application/pdf',
    });

    expect(envelope.markdown).toBe('# Page 1\n\nfirst page\n\n---\n\n# Page 2\n\nsecond page');
  });

  it('uses raw content when provided (passthrough markdown)', () => {
    const azureResult: AzureAnalyzeResult = {
      pages: [{ pageNumber: 1, lines: [{ content: 'ignored' }] }],
      content: '# Authentic Azure Markdown\n\nProvided by the response.',
    };

    const envelope = normalizeAzureAnalyzeResult(azureResult, {
      sourceUrl: SOURCE_URL,
      contentType: 'application/pdf',
    });

    expect(envelope.markdown).toContain('Authentic Azure Markdown');
  });
});
