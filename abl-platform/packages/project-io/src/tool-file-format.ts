import { parseToolFile } from '@abl/core/parser';

export interface ToolFileValidationError {
  line: number;
  message: string;
}

export interface CanonicalToolFileResult {
  content: string;
  normalized: boolean;
  validationErrors: ToolFileValidationError[];
}

function wrapStandaloneToolDsl(content: string): string {
  const lines = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const indented = lines.map((line) => (line.length > 0 ? `  ${line}` : ''));
  return `TOOLS:\n${indented.join('\n')}`;
}

function hasCanonicalToolsSection(content: string): boolean {
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  for (const [index, rawLine] of lines.entries()) {
    const line = index === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    return trimmed === 'TOOLS:';
  }

  return false;
}

function validateCanonicalToolFile(content: string): ToolFileValidationError[] {
  try {
    const result = parseToolFile(content);
    return result.errors.map((error) => ({
      line: error.line,
      message: error.message,
    }));
  } catch (error) {
    return [
      {
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

export function canonicalizeToolFileContent(content: string): CanonicalToolFileResult {
  const normalizedContent = hasCanonicalToolsSection(content)
    ? content
    : wrapStandaloneToolDsl(content);

  return {
    content: normalizedContent,
    normalized: normalizedContent !== content,
    validationErrors: validateCanonicalToolFile(normalizedContent),
  };
}
