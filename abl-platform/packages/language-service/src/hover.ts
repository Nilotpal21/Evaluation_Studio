import type { Position, HoverInfo } from './types.js';
import { KEYWORD_DOCS } from './docs.js';

export function getHoverInfo(source: string, position: Position): HoverInfo | null {
  const lines = source.split('\n');
  const line = lines[position.line - 1];
  if (!line) return null;

  const word = getWordAtPosition(line, position.column - 1);
  if (!word) return null;

  const normalizedWord = word.toLowerCase().replace(/\s*:$/, '');
  const doc = KEYWORD_DOCS[normalizedWord];
  if (!doc) return null;

  return { contents: doc, line: position.line, column: position.column };
}

function getWordAtPosition(line: string, column: number): string | null {
  let start = column;
  let end = column;
  while (start > 0 && /[a-zA-Z_]/.test(line[start - 1])) start--;
  while (end < line.length && /[a-zA-Z_:]/.test(line[end])) end++;
  const word = line.substring(start, end).trim();
  return word || null;
}
