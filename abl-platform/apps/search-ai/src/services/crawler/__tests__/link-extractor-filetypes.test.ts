import { describe, it, expect } from 'vitest';
import { extractLinks, detectFileType, DOCUMENT_EXTENSIONS } from '../link-extractor.js';

/**
 * Tests for file URL handling in link-extractor.
 *
 * Verifies that:
 * - Document URLs (.pdf, .docx, etc.) are discovered but not recursed into
 * - Binary/archive URLs (.zip, .exe, etc.) are still skipped entirely
 * - File URLs get tagged with the correct fileType
 */

const BASE_URL = 'https://example.com/page';
const DOMAIN = 'example.com';

function makeHtml(links: string[]): string {
  const anchors = links.map((href) => `<a href="${href}">Link</a>`).join('\n');
  return `<html><body>${anchors}</body></html>`;
}

describe('detectFileType', () => {
  it('detects PDF files', () => {
    expect(detectFileType('/docs/report.pdf')).toBe('pdf');
  });

  it('detects DOCX files', () => {
    expect(detectFileType('/files/document.docx')).toBe('docx');
  });

  it('detects XLSX files', () => {
    expect(detectFileType('/data/spreadsheet.xlsx')).toBe('xlsx');
  });

  it('detects PPTX files', () => {
    expect(detectFileType('/slides/presentation.pptx')).toBe('pptx');
  });

  it('detects CSV files', () => {
    expect(detectFileType('/export/data.csv')).toBe('csv');
  });

  it('detects TXT files', () => {
    expect(detectFileType('/readme.txt')).toBe('txt');
  });

  it('returns null for HTML pages', () => {
    expect(detectFileType('/about/team')).toBeNull();
  });

  it('returns null for paths without extension', () => {
    expect(detectFileType('/products/widget')).toBeNull();
  });

  it('returns null for non-document extensions', () => {
    expect(detectFileType('/image.png')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectFileType('/Report.PDF')).toBe('pdf');
    expect(detectFileType('/Data.XLSX')).toBe('xlsx');
  });
});

describe('extractLinks — file type handling', () => {
  it('includes PDF URLs in extractedLinks with fileType tag', () => {
    const html = makeHtml(['https://example.com/report.pdf']);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    expect(result.extractedLinks).toHaveLength(1);
    expect(result.extractedLinks[0].fileType).toBe('pdf');
    expect(result.extractedLinks[0].url).toContain('report.pdf');
  });

  it('excludes PDF URLs from links (not recursed into)', () => {
    const html = makeHtml(['https://example.com/report.pdf', 'https://example.com/about']);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    // links should only have the page URL
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toContain('about');
    // extractedLinks should have both
    expect(result.extractedLinks).toHaveLength(2);
  });

  it('still skips .zip files entirely', () => {
    const html = makeHtml(['https://example.com/archive.zip']);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    expect(result.links).toHaveLength(0);
    expect(result.extractedLinks).toHaveLength(0);
  });

  it('still skips .exe files entirely', () => {
    const html = makeHtml(['https://example.com/installer.exe']);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    expect(result.links).toHaveLength(0);
    expect(result.extractedLinks).toHaveLength(0);
  });

  it('still skips .7z files entirely', () => {
    const html = makeHtml(['https://example.com/backup.7z']);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    expect(result.links).toHaveLength(0);
    expect(result.extractedLinks).toHaveLength(0);
  });

  it('tags .docx URLs with fileType docx', () => {
    const html = makeHtml(['https://example.com/manual.docx']);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    expect(result.extractedLinks).toHaveLength(1);
    expect(result.extractedLinks[0].fileType).toBe('docx');
  });

  it('tags .xlsx URLs with fileType xlsx', () => {
    const html = makeHtml(['https://example.com/data.xlsx']);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    expect(result.extractedLinks).toHaveLength(1);
    expect(result.extractedLinks[0].fileType).toBe('xlsx');
  });

  it('sets fileType to null for regular page URLs', () => {
    const html = makeHtml(['https://example.com/about']);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    expect(result.extractedLinks).toHaveLength(1);
    expect(result.extractedLinks[0].fileType).toBeNull();
  });

  it('handles mixed page and file URLs correctly', () => {
    const html = makeHtml([
      'https://example.com/page1',
      'https://example.com/report.pdf',
      'https://example.com/page2',
      'https://example.com/data.csv',
      'https://example.com/archive.zip', // should be skipped entirely
    ]);
    const result = extractLinks(html, BASE_URL, DOMAIN);

    // links: only page URLs (no files)
    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toContain('page1');
    expect(result.links[1]).toContain('page2');

    // extractedLinks: pages + document files (not zip)
    expect(result.extractedLinks).toHaveLength(4);
    const fileTypes = result.extractedLinks.map((l) => l.fileType);
    expect(fileTypes).toEqual([null, 'pdf', null, 'csv']);
  });

  it('all DOCUMENT_EXTENSIONS are allowed through', () => {
    const docExtensions = [...DOCUMENT_EXTENSIONS];
    for (const ext of docExtensions) {
      const html = makeHtml([`https://example.com/file${ext}`]);
      const result = extractLinks(html, BASE_URL, DOMAIN);

      expect(result.extractedLinks.length).toBeGreaterThanOrEqual(1);
      const found = result.extractedLinks.find((l) => l.fileType !== null);
      expect(found).toBeDefined();
      expect(found?.fileType).toBe(ext.substring(1)); // without the leading dot
    }
  });
});
