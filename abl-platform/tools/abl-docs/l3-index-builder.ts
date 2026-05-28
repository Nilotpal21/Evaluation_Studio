import { promises as fs } from 'fs';
import path from 'path';

export interface L3BuilderChunk {
  file: string;
  heading: string;
  text: string;
  words: number;
}

export interface L3BuilderIndex {
  version: number;
  chunks: L3BuilderChunk[];
  df: Record<string, number>;
  avgdl: number;
  N: number;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '');
}

// Must match packages/arch-ai/src/knowledge/l3-search.ts STOPWORDS exactly.
const STOPWORDS = new Set<string>();
for (const w of [
  'about',
  'after',
  'all',
  'also',
  'and',
  'any',
  'are',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'can',
  'could',
  'did',
  'does',
  'doing',
  'each',
  'for',
  'from',
  'get',
  'had',
  'has',
  'have',
  'her',
  'here',
  'him',
  'his',
  'how',
  'into',
  'its',
  'just',
  'like',
  'make',
  'many',
  'may',
  'more',
  'most',
  'must',
  'not',
  'now',
  'only',
  'other',
  'our',
  'out',
  'over',
  'own',
  'said',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'too',
  'under',
  'use',
  'very',
  'want',
  'was',
  'way',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]) {
  STOPWORDS.add(w);
}

function tokenize(text: string): string[] {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/[|#*_\->[\](){}]/g, ' ')
    .toLowerCase();
  return cleaned.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function extractHeading(section: string): string {
  const match = section.match(/^#{2,3}\s+(.+)/m);
  return match ? match[1].trim() : 'untitled';
}

export function chunkMdxFile(filePath: string, content: string): L3BuilderChunk[] {
  const body = stripFrontmatter(content);
  const h2Sections = body.split(/(?=^## )/m);
  const chunks: L3BuilderChunk[] = [];

  for (const section of h2Sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/).length;
    if (words < 10) continue;

    if (words <= 600) {
      chunks.push({
        file: filePath,
        heading: extractHeading(trimmed),
        text: trimmed,
        words,
      });
    } else {
      const h3Sections = trimmed.split(/(?=^### )/m);
      for (const sub of h3Sections) {
        const subTrimmed = sub.trim();
        const subWords = subTrimmed.split(/\s+/).length;
        if (subWords >= 10) {
          chunks.push({
            file: filePath,
            heading: extractHeading(subTrimmed),
            text: subTrimmed,
            words: subWords,
          });
        }
      }
    }
  }

  return chunks;
}

export function buildL3Index(chunks: L3BuilderChunk[]): L3BuilderIndex {
  const N = chunks.length;
  const df: Record<string, number> = {};
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    totalLength += tokens.length;
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        df[t] = (df[t] ?? 0) + 1;
        seen.add(t);
      }
    }
  }

  return {
    version: 1,
    chunks,
    df,
    avgdl: N > 0 ? totalLength / N : 0,
    N,
  };
}

async function collectMdxFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectMdxFiles(full)));
    } else if (entry.name.endsWith('.mdx')) {
      results.push(full);
    }
  }
  return results;
}

export async function generateL3Index(contentDir: string): Promise<L3BuilderIndex> {
  const files = await collectMdxFiles(contentDir);
  const allChunks: L3BuilderChunk[] = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, 'utf8');
    const relativePath = path.relative(contentDir, filePath);
    const chunks = chunkMdxFile(relativePath, content);
    allChunks.push(...chunks);
  }

  return buildL3Index(allChunks);
}
