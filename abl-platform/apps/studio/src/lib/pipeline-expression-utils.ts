/**
 * Pipeline expression utilities — pure functions with no side effects.
 *
 * Extracted from ExpressionEditor.tsx so these can be tested without
 * loading Monaco or the ContractRegistry.
 */

/** A resolved reference from a pipeline expression string. */
export interface ExpressionRef {
  path: string;
  nodeId: string;
  field: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Extract all {{steps.X.output.Y}} and raw steps.X.output.Y references from a string.
 * Returns an empty array when no references are found.
 */
export function extractExpressionRefs(text: string): ExpressionRef[] {
  const refs: ExpressionRef[] = [];
  const templatePattern = /\{\{steps\.([^.}]+)\.output\.([^}]+)\}\}/g;
  const rawPattern = /steps\.([a-zA-Z_][\w-]*)\.output\.([a-zA-Z_][\w.-]*)/g;
  let m: RegExpExecArray | null;

  while ((m = templatePattern.exec(text)) !== null) {
    refs.push({
      path: m[0],
      nodeId: m[1],
      field: m[2],
      startIndex: m.index,
      endIndex: m.index + m[0].length,
    });
  }

  while ((m = rawPattern.exec(text)) !== null) {
    const startIndex = m.index;
    const endIndex = m.index + m[0].length;
    const isInsideTemplateRef = refs.some(
      (ref) => startIndex >= ref.startIndex && endIndex <= ref.endIndex,
    );
    if (isInsideTemplateRef || isWrappedInBraces(text, startIndex, endIndex)) continue;

    refs.push({
      path: m[0],
      nodeId: m[1],
      field: m[2],
      startIndex,
      endIndex,
    });
  }

  refs.sort((a, b) => a.startIndex - b.startIndex);
  return refs;
}

function isWrappedInBraces(text: string, startIndex: number, endIndex: number): boolean {
  let before = startIndex - 1;
  while (before >= 0 && /\s/.test(text[before])) before--;

  let after = endIndex;
  while (after < text.length && /\s/.test(text[after])) after++;

  return text[before] === '{' || text[after] === '}';
}
