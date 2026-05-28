import { promises as fs } from 'fs';
import path from 'path';
import type { CardMappingEntry } from './card-mapping.js';
import { CARD_MAPPINGS } from './card-mapping.js';

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 800;

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '');
}

function extractSections(body: string, sectionFilters?: string[]): string {
  if (!sectionFilters || sectionFilters.length === 0) return body;

  const h2Sections = body.split(/(?=^## )/m);
  const matched: string[] = [];

  for (const section of h2Sections) {
    const heading = section.match(/^#{2,3}\s+(.+)/m)?.[1]?.trim() ?? '';
    const matchesFilter = sectionFilters.some((f) =>
      heading.toLowerCase().includes(f.toLowerCase()),
    );
    if (matchesFilter) {
      matched.push(section.trim());
    }
  }

  return matched.length > 0 ? matched.join('\n\n') : body;
}

function compressToCardFormat(rawContent: string, maxChars: number): string {
  const lines = rawContent.split('\n');
  const compressed: string[] = [];
  let inCodeBlock = false;
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      compressed.push(line);
      continue;
    }
    if (inCodeBlock) {
      compressed.push(line);
      continue;
    }
    if (line.startsWith('|')) {
      inTable = true;
      compressed.push(line);
      continue;
    }
    if (inTable && !line.startsWith('|')) {
      inTable = false;
    }
    if (line.startsWith('#')) {
      compressed.push(line);
      continue;
    }
    if (line.match(/^\s*[-*]\s/)) {
      compressed.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length > 100) {
      const firstSentence = trimmed.match(/^[^.!?]+[.!?]/)?.[0] ?? trimmed.slice(0, 100);
      compressed.push(`- ${firstSentence}`);
    } else if (trimmed.length > 0) {
      compressed.push(line);
    }
  }

  let content = compressed.join('\n');

  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline > maxChars * 0.8) {
      content = content.slice(0, lastNewline);
    }
  }

  return content;
}

export interface GeneratedCard {
  id: string;
  exportName: string;
  fileName: string;
  content: string;
  tsSource: string;
}

export async function generateCard(
  entry: CardMappingEntry,
  contentDir: string,
): Promise<GeneratedCard> {
  const maxTokens = entry.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts: string[] = [];

  for (const source of entry.sources) {
    const filePath = path.join(contentDir, source.file);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      console.warn(`Warning: MDX source not found: ${source.file} (card: ${entry.id})`);
      continue;
    }
    const body = stripFrontmatter(content);
    const extracted = extractSections(body, source.sections);
    parts.push(extracted);
  }

  let combined = parts.join('\n\n');

  const titleLine = `## ${entry.title}`;
  const preserveBlock =
    entry.preserveContent && entry.preserveContent.length > 0
      ? '\n\n' + entry.preserveContent.join('\n\n')
      : '';

  const budgetForBody = maxChars - titleLine.length - 10 - preserveBlock.length;
  const compressed = compressToCardFormat(combined, Math.max(budgetForBody, 500));

  const cardContent = `${titleLine}\n\n${compressed}${preserveBlock}`;

  const escapedContent = cardContent
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  const sourceFiles = entry.sources.map((s) => s.file).join(', ');
  const tsSource = `// Auto-generated from docs-internal MDX. Do not edit manually.\n// Sources: ${sourceFiles}\n// Regenerate: pnpm abl:docs:generate\n\nexport const ${entry.exportName} = \`${escapedContent}\`;\n`;

  return {
    id: entry.id,
    exportName: entry.exportName,
    fileName: `${entry.id}.ts`,
    content: cardContent,
    tsSource,
  };
}

export async function generateAllCards(
  contentDir: string,
  mappings?: CardMappingEntry[],
): Promise<GeneratedCard[]> {
  const entries = mappings ?? CARD_MAPPINGS;
  const cards: GeneratedCard[] = [];
  for (const entry of entries) {
    cards.push(await generateCard(entry, contentDir));
  }
  return cards;
}
