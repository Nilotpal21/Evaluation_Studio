import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CHARS_PER_TOKEN = 4;

export interface L3Chunk {
  file: string;
  heading: string;
  text: string;
  words: number;
}

export interface L3Index {
  version: number;
  chunks: L3Chunk[];
  df: Record<string, number>;
  avgdl: number;
  N: number;
  tfPerChunk: Array<{ tf: Record<string, number>; length: number }>;
}

export interface L3SearchResult {
  file: string;
  heading: string;
  text: string;
  score: number;
}

// BM25 stopwords — high-df words that drown out content-word signal.
// Curated from standard English IR stopwords; excludes domain terms
// that could be meaningful in ABL/platform queries.
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

export function buildBm25Index(chunks: L3Chunk[]): L3Index {
  const N = chunks.length;
  const df: Record<string, number> = {};
  const tfPerChunk: Array<{ tf: Record<string, number>; length: number }> = [];
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    totalLength += tokens.length;
    const tf: Record<string, number> = {};
    for (const t of tokens) {
      tf[t] = (tf[t] ?? 0) + 1;
    }
    tfPerChunk.push({ tf, length: tokens.length });
    for (const t of Object.keys(tf)) {
      df[t] = (df[t] ?? 0) + 1;
    }
  }

  return {
    version: 1,
    chunks,
    df,
    avgdl: N > 0 ? totalLength / N : 0,
    N,
    tfPerChunk,
  };
}

export function searchBm25(index: L3Index, query: string, topK: number): L3SearchResult[] {
  const k1 = 1.5;
  const b = 0.75;
  const queryTokens = tokenize(query);
  const { N, df, tfPerChunk, avgdl, chunks } = index;
  const scores = new Float64Array(N);

  for (const qt of queryTokens) {
    const docFreq = df[qt] ?? 0;
    if (docFreq === 0) continue;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);

    for (let i = 0; i < N; i++) {
      const tf = tfPerChunk[i].tf[qt] ?? 0;
      if (tf === 0) continue;
      const dl = tfPerChunk[i].length;
      scores[i] += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)));
    }
  }

  // Demote navigation chunks (index pages, link lists) that score high
  // due to BM25 short-document bias — they mention every term but
  // contain no actual content.
  const NAV_PENALTY = 0.5;
  for (let i = 0; i < N; i++) {
    if (scores[i] === 0) continue;
    const file = chunks[i].file;
    const heading = chunks[i].heading;
    if (file.endsWith('index.mdx') || heading === 'Further Reading' || heading === 'Next steps') {
      scores[i] *= NAV_PENALTY;
    }
  }

  const indices = Array.from({ length: N }, (_, i) => i);
  indices.sort((a, b2) => scores[b2] - scores[a]);

  return indices.slice(0, topK).map((i) => ({
    file: chunks[i].file,
    heading: chunks[i].heading,
    text: chunks[i].text,
    score: scores[i],
  }));
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

let _cachedIndex: L3Index | null = null;

export function loadL3Index(): L3Index {
  if (_cachedIndex) return _cachedIndex;
  // l3-index.json lives alongside this file in both src/ and dist/
  // (postbuild copies it to dist/knowledge/)
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), 'l3-index.json');
  const raw = JSON.parse(readFileSync(indexPath, 'utf8')) as L3Index;
  if (!raw.tfPerChunk) {
    const tfPerChunk: Array<{ tf: Record<string, number>; length: number }> = [];
    for (const chunk of raw.chunks) {
      const tokens = tokenize(chunk.text);
      const tf: Record<string, number> = {};
      for (const t of tokens) {
        tf[t] = (tf[t] ?? 0) + 1;
      }
      tfPerChunk.push({ tf, length: tokens.length });
    }
    raw.tfPerChunk = tfPerChunk;
  }
  _cachedIndex = raw;
  return _cachedIndex;
}

export function resetL3Cache(): void {
  _cachedIndex = null;
}

export interface DocSearchResult {
  file: string;
  sections: Array<{ heading: string; text: string; score: number }>;
  bestScore: number;
}

export function searchDocsGrouped(query: string, maxResults: number = 5): DocSearchResult[] {
  const index = loadL3Index();
  const candidates = searchBm25(index, query, 50);

  const fileMap = new Map<string, Array<{ heading: string; text: string; score: number }>>();
  const fileBestScore = new Map<string, number>();

  for (const candidate of candidates) {
    if (candidate.score === 0) break;
    const sections = fileMap.get(candidate.file) ?? [];
    sections.push({
      heading: candidate.heading,
      text: candidate.text,
      score: candidate.score,
    });
    fileMap.set(candidate.file, sections);

    const current = fileBestScore.get(candidate.file) ?? 0;
    if (candidate.score > current) {
      fileBestScore.set(candidate.file, candidate.score);
    }
  }

  return Array.from(fileBestScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([file, bestScore]) => ({
      file,
      sections: fileMap.get(file) ?? [],
      bestScore,
    }));
}
