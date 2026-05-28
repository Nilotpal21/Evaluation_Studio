import type { Hover } from 'vscode-languageserver';
import type { HoverInfo } from '@abl/language-service';

export function toLSPHover(info: HoverInfo): Hover {
  return {
    contents: {
      kind: 'markdown',
      value: info.contents,
    },
    range: {
      start: { line: Math.max(0, info.line - 1), character: Math.max(0, info.column - 1) },
      end: { line: Math.max(0, info.line - 1), character: Math.max(0, info.column - 1) },
    },
  };
}
