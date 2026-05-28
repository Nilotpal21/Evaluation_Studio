/**
 * Azure Document Intelligence `analyzeResult` → canonical `ExtractionEnvelope`
 * (LLD §3 Phase 3 Task 3.6).
 *
 * Pure function; no side effects. Maps the v3+ "analyze" response shape:
 *   - `pages[].lines[].content` → page text
 *   - `tables[].cells` → ExtractionTable.rows + synthesized markdown
 *   - `paragraphs[].role === 'sectionHeading' | 'title'` → headings
 *   - `languages[]` (highest confidence) → metadata.language + confidence
 *
 * Both v3.x ("apiVersion=2023-07-31") and the 2024-11-30 GA shape are covered;
 * the parser tolerates either `lines[]` (older models) or `paragraphs[]` (newer)
 * for page text.
 */

import type {
  ExtractionEnvelope,
  ExtractionHeading,
  ExtractionPage,
  ExtractionTable,
} from './types';

export interface AzureAnalyzeCell {
  rowIndex: number;
  columnIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  content: string;
  kind?: string;
}

export interface AzureAnalyzeTable {
  rowCount: number;
  columnCount: number;
  cells: AzureAnalyzeCell[];
  boundingRegions?: Array<{ pageNumber: number; polygon?: number[] }>;
}

export interface AzureAnalyzeLanguage {
  locale: string;
  confidence: number;
  spans?: Array<{ offset: number; length: number }>;
}

export interface AzureAnalyzeParagraph {
  role?: string;
  content: string;
  boundingRegions?: Array<{ pageNumber: number; polygon?: number[] }>;
}

export interface AzureAnalyzePage {
  pageNumber: number;
  angle?: number;
  width?: number;
  height?: number;
  unit?: string;
  lines?: Array<{ content: string; polygon?: number[] }>;
  words?: Array<{ content: string; confidence?: number }>;
}

export interface AzureAnalyzeResult {
  apiVersion?: string;
  modelId?: string;
  stringIndexType?: string;
  content?: string;
  pages: AzureAnalyzePage[];
  paragraphs?: AzureAnalyzeParagraph[];
  tables?: AzureAnalyzeTable[];
  languages?: AzureAnalyzeLanguage[];
  styles?: Array<{ isHandwritten?: boolean; spans?: unknown }>;
}

export interface AzureNormalizeOptions {
  sourceUrl: string;
  contentType: string;
  includeRaw?: boolean;
}

/** Map an Azure DI `analyzeResult` payload into the canonical `ExtractionEnvelope`. */
export function normalizeAzureAnalyzeResult(
  result: AzureAnalyzeResult,
  options: AzureNormalizeOptions,
): ExtractionEnvelope {
  const pagesByNumber = new Map<number, AzureAnalyzePage>();
  for (const p of result.pages ?? []) {
    pagesByNumber.set(p.pageNumber, p);
  }

  const tablesByPage = groupTablesByPage(result.tables ?? []);
  const headingsByPage = groupHeadingsByPage(result.paragraphs ?? []);

  const pageNumbers = Array.from(pagesByNumber.keys()).sort((a, b) => a - b);

  const pages: ExtractionPage[] = pageNumbers.map((pageNumber) => {
    const page = pagesByNumber.get(pageNumber)!;
    return {
      pageNumber,
      text: derivePageText(page, result.paragraphs ?? []),
      tables: (tablesByPage.get(pageNumber) ?? []).map((t) => synthesizeTable(t)),
      images: [],
      headings: headingsByPage.get(pageNumber) ?? [],
    };
  });

  const markdown = synthesizeMarkdown(pages, result.content);
  const language = pickLanguage(result.languages ?? []);
  const hasOCR =
    (result.pages?.some((p) => Array.isArray(p.words) && p.words.length > 0) ?? false) ||
    (result.styles?.some((s) => s.isHandwritten === true) ?? false);

  const envelope: ExtractionEnvelope = {
    schemaVersion: 1,
    provider: 'azure-document-intelligence',
    sourceUrl: options.sourceUrl,
    contentType: options.contentType,
    markdown,
    pages,
    metadata: {
      pageCount: pages.length,
      ...(language ? { language: language.locale } : {}),
      ...(language ? { languageConfidence: language.confidence } : {}),
      hasOCR,
    },
    ...(options.includeRaw ? { raw: result } : {}),
  };

  return envelope;
}

function groupTablesByPage(tables: AzureAnalyzeTable[]): Map<number, AzureAnalyzeTable[]> {
  const out = new Map<number, AzureAnalyzeTable[]>();
  for (const t of tables) {
    const pageNumber = t.boundingRegions?.[0]?.pageNumber ?? 1;
    const list = out.get(pageNumber) ?? [];
    list.push(t);
    out.set(pageNumber, list);
  }
  return out;
}

function groupHeadingsByPage(
  paragraphs: AzureAnalyzeParagraph[],
): Map<number, ExtractionHeading[]> {
  const out = new Map<number, ExtractionHeading[]>();
  for (const p of paragraphs) {
    if (p.role !== 'title' && p.role !== 'sectionHeading') continue;
    const pageNumber = p.boundingRegions?.[0]?.pageNumber ?? 1;
    const level = p.role === 'title' ? 1 : 2;
    const list = out.get(pageNumber) ?? [];
    list.push({ level, text: p.content });
    out.set(pageNumber, list);
  }
  return out;
}

function derivePageText(page: AzureAnalyzePage, paragraphs: AzureAnalyzeParagraph[]): string {
  if (Array.isArray(page.lines) && page.lines.length > 0) {
    return page.lines.map((l) => l.content).join('\n');
  }
  const pageParas = paragraphs.filter(
    (p) => (p.boundingRegions?.[0]?.pageNumber ?? 1) === page.pageNumber,
  );
  return pageParas.map((p) => p.content).join('\n\n');
}

function synthesizeTable(table: AzureAnalyzeTable): ExtractionTable {
  const rows: string[][] = Array.from({ length: table.rowCount }, () =>
    Array.from({ length: table.columnCount }, () => ''),
  );
  for (const cell of table.cells) {
    const row = rows[cell.rowIndex];
    if (row && cell.columnIndex < row.length) {
      row[cell.columnIndex] = cell.content;
    }
  }
  const markdown = synthesizeTableMarkdown(rows);
  return { rows, markdown };
}

function synthesizeTableMarkdown(rows: string[][]): string {
  const headerRow = rows[0];
  if (!headerRow) return '';
  const cols = headerRow.length;
  if (cols === 0) return '';
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const header = headerRow.map(escape).join(' | ');
  const separator = Array.from({ length: cols }, () => '---').join(' | ');
  const body = rows
    .slice(1)
    .map((r) => r.map(escape).join(' | '))
    .join('\n');
  return body.length > 0
    ? `| ${header} |\n| ${separator} |\n| ${body.split('\n').join(' |\n| ')} |`
    : `| ${header} |\n| ${separator} |`;
}

function synthesizeMarkdown(pages: ExtractionPage[], rawContent: string | undefined): string {
  if (rawContent && rawContent.trim().length > 0) {
    return rawContent;
  }
  return pages.map((p) => `# Page ${p.pageNumber}\n\n${p.text}`).join('\n\n---\n\n');
}

function pickLanguage(languages: AzureAnalyzeLanguage[]): AzureAnalyzeLanguage | null {
  if (languages.length === 0) return null;
  let best = languages[0]!;
  for (const lang of languages.slice(1)) {
    if (lang.confidence > best.confidence) best = lang;
  }
  return best;
}
