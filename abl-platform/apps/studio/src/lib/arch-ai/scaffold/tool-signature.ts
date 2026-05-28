export interface ToolSignatureField {
  name: string;
  type: string;
  optional?: boolean;
  defaultValue?: string;
}

export interface ParsedToolSignature {
  toolName: string;
  inputFields: ToolSignatureField[];
  outputFields: ToolSignatureField[];
  outputLiteral: string;
  outputIsObject: boolean;
}

export function parseToolSignature(signature: string | undefined): ParsedToolSignature | null {
  const trimmed = signature?.trim();
  const header = trimmed?.match(/^([A-Za-z_][A-Za-z0-9_]*(?:[./-][A-Za-z_][A-Za-z0-9_]*)*)\s*\(/);
  if (!trimmed || !header?.[1]) {
    return null;
  }

  const inputStart = trimmed.indexOf('(', header[0].length - 1);
  if (inputStart < 0) {
    return null;
  }
  const inputEnd = findMatchingDelimiter(trimmed, inputStart, '(', ')');
  if (inputEnd < 0) {
    return null;
  }

  const afterInput = trimmed.slice(inputEnd + 1).trim();
  if (!afterInput.startsWith('->')) {
    return null;
  }

  const outputLiteral = afterInput.slice(2).trim();
  if (!outputLiteral) {
    return null;
  }

  const objectOutput = extractWrappedObjectLiteral(outputLiteral);
  return {
    toolName: header[1],
    inputFields: parseToolFieldList(trimmed.slice(inputStart + 1, inputEnd)),
    outputFields: objectOutput ? parseToolFieldList(objectOutput) : [],
    outputLiteral,
    outputIsObject: objectOutput !== null,
  };
}

export function inferInputFieldNamesFromSignature(signature: string | undefined): string[] {
  return parseToolSignature(signature)?.inputFields.map((field) => field.name) ?? [];
}

export function inferOutputFieldNamesFromSignature(signature: string | undefined): string[] {
  return parseToolSignature(signature)?.outputFields.map((field) => field.name) ?? [];
}

export function renderToolFields(fields: ReadonlyArray<ToolSignatureField>): string {
  return fields
    .map((field) => {
      const optional = field.optional ? '?' : '';
      const defaultValue = field.defaultValue ? ` = ${field.defaultValue}` : '';
      return `${field.name}${optional}: ${field.type}${defaultValue}`;
    })
    .join(', ');
}

export function renderToolReturn(
  sourceSignatureShape: ParsedToolSignature | null,
  fields: ReadonlyArray<ToolSignatureField>,
): string {
  if (fields.length === 0 && sourceSignatureShape && !sourceSignatureShape.outputIsObject) {
    return sourceSignatureShape.outputLiteral;
  }
  return `{ ${renderToolFields(fields)} }`;
}

function parseToolFieldList(value: string): ToolSignatureField[] {
  return dedupeToolFields(
    splitTopLevelFields(value)
      .map(parseToolField)
      .filter((field): field is ToolSignatureField => field !== null),
  );
}

function parseToolField(value: string): ToolSignatureField | null {
  const match = value.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:\s*(.+)$/s);
  if (!match?.[1]) {
    return null;
  }

  const { before: type, after: defaultValue } = splitTopLevelAssignment(match[3]?.trim() ?? '');
  return {
    name: match[1],
    type: type.trim() || 'string',
    ...(match[2] ? { optional: true } : {}),
    ...(defaultValue ? { defaultValue: defaultValue.trim() } : {}),
  };
}

function dedupeToolFields(fields: ReadonlyArray<ToolSignatureField>): ToolSignatureField[] {
  const merged: ToolSignatureField[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    if (seen.has(field.name)) {
      continue;
    }
    seen.add(field.name);
    merged.push(field);
  }

  return merged;
}

function splitTopLevelFields(value: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[' || char === '(' || char === '<') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']' || char === ')' || char === '>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ',' && depth === 0) {
      const field = value.slice(start, index).trim();
      if (field) fields.push(field);
      start = index + 1;
    }
  }

  const tail = value.slice(start).trim();
  if (tail) fields.push(tail);
  return fields;
}

function splitTopLevelAssignment(value: string): { before: string; after?: string } {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[' || char === '(' || char === '<') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']' || char === ')' || char === '>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === '=' && depth === 0) {
      return { before: value.slice(0, index), after: value.slice(index + 1) };
    }
  }

  return { before: value };
}

function extractWrappedObjectLiteral(value: string): string | null {
  const start = value.indexOf('{');
  if (start < 0 || value.slice(0, start).trim().length > 0) {
    return null;
  }
  const end = findMatchingDelimiter(value, start, '{', '}');
  if (end < 0) {
    return null;
  }
  return value.slice(start + 1, end);
}

function findMatchingDelimiter(
  value: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;

  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}
