import crypto from 'crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SEED_MOCK_RESPONSES } = require('../../scripts/fixtures/seed-mock-responses.ts') as {
  SEED_MOCK_RESPONSES: Record<string, unknown>;
};

type SeedProjectToolType = 'http' | 'sandbox' | 'mcp' | 'searchai';

interface ParsedTool {
  name: string;
  signature: string;
  description: string | null;
  toolType: SeedProjectToolType;
  rawBlock: string;
}

export interface SeedProjectTool {
  name: string;
  toolType: SeedProjectToolType;
  description: string | null;
  dslContent: string;
  sourceHash: string;
}

const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;

function extractToolsSection(dslContent: string): string | null {
  const lines = dslContent.split('\n');
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (/^TOOLS:\s*$/.test(lines[i])) {
      start = i;
      continue;
    }
    if (start >= 0 && i > start && /^[A-Z][A-Z_]*:/.test(lines[i])) {
      end = i;
      break;
    }
  }

  if (start < 0) return null;
  return lines.slice(start + 1, end).join('\n');
}

function parseInlineSignatureTool(
  lines: string[],
  startIdx: number,
  sigMatch: RegExpMatchArray,
): { parsed: ParsedTool; nextIndex: number } {
  const name = sigMatch[1];
  const params = sigMatch[2];
  const returnType = sigMatch[3] || 'object';
  const signature = `${name}(${params}) -> ${returnType}`;

  let description: string | null = null;
  let toolType: SeedProjectToolType = 'sandbox';
  const propLines: string[] = [];
  let j = startIdx + 1;

  while (j < lines.length) {
    const propLine = lines[j];
    const propTrimmed = propLine.trim();

    if (!propTrimmed) {
      let nextNonEmpty = j + 1;
      while (nextNonEmpty < lines.length && !lines[nextNonEmpty].trim()) nextNonEmpty++;
      if (nextNonEmpty >= lines.length || !/^\s{4,}/.test(lines[nextNonEmpty])) {
        j++;
        break;
      }
      j++;
      continue;
    }

    if (/^\s{4,}/.test(propLine) || /^\t/.test(propLine)) {
      propLines.push(propTrimmed);

      if (propTrimmed.startsWith('description:')) {
        description = propTrimmed.replace(/^description:\s*"?/, '').replace(/"$/, '');
      }
      if (propTrimmed.startsWith('type:')) {
        const typeVal = propTrimmed.replace(/^type:\s*/, '').trim();
        if (typeVal === 'http') toolType = 'http';
        else if (typeVal === 'mcp') toolType = 'mcp';
        else if (typeVal === 'searchai') toolType = 'searchai';
        else if (typeVal === 'lambda') toolType = 'sandbox';
        else toolType = 'sandbox';
      }
      j++;
    } else {
      break;
    }
  }

  // Infer toolType from property indicators when no explicit `type:` was found.
  // The LLM often generates tools with endpoint/method but omits `type: http`.
  // Without this, all such tools default to sandbox with mock responses.
  if (toolType === 'sandbox') {
    const joined = propLines.join('\n');
    if (
      /\b(endpoint|url)\s*:/i.test(joined) ||
      /\bmethod\s*:\s*(GET|POST|PUT|PATCH|DELETE)\b/i.test(joined)
    ) {
      toolType = 'http';
    } else if (/\bserver\s*:/i.test(joined)) {
      toolType = 'mcp';
    }
  }

  const rawBlock =
    toolType === 'sandbox'
      ? buildSandboxDsl(name, signature, description)
      : buildOriginalDsl(signature, propLines, toolType);

  return {
    parsed: { name, signature, description, toolType, rawBlock },
    nextIndex: j,
  };
}

function parseNameBlockTool(
  lines: string[],
  startIdx: number,
  name: string,
): { parsed: ParsedTool; nextIndex: number } {
  let description: string | null = null;
  const params: string[] = [];
  const blockIndent = lines[startIdx].search(/\S/);
  let j = startIdx + 1;

  while (j < lines.length) {
    const rawLine = lines[j];
    const propLine = rawLine.trim();
    if (!propLine) {
      j++;
      continue;
    }

    const lineIndent = rawLine.search(/\S/);
    if (lineIndent <= blockIndent && propLine.startsWith('- NAME:')) break;
    if (/^[A-Z][A-Z_]*:/.test(propLine) && lineIndent === 0) break;

    if (propLine.startsWith('DESCRIPTION:')) {
      description = propLine.replace(/^DESCRIPTION:\s*"?/, '').replace(/"$/, '');
    }

    if (propLine.startsWith('- ') && !propLine.startsWith('- NAME:') && lineIndent > blockIndent) {
      const paramMatch = propLine.match(/^-\s+(\w+):\s*"?([^"]*)"?/);
      if (paramMatch) {
        params.push(`${paramMatch[1]}: string`);
      }
    }

    j++;
  }

  const paramStr = params.length > 0 ? params.join(', ') : 'query: string';
  const signature = `${name}(${paramStr}) -> object`;
  const rawBlock = buildSandboxDsl(name, signature, description);

  return {
    parsed: { name, signature, description, toolType: 'sandbox', rawBlock },
    nextIndex: j,
  };
}

function parseKeyValueTool(
  lines: string[],
  startIdx: number,
  name: string,
): { parsed: ParsedTool; nextIndex: number } | null {
  let description: string | null = null;
  const params: string[] = [];
  let returns = 'object';
  const toolIndent = lines[startIdx].search(/\S/);
  let j = startIdx + 1;
  let hasContent = false;

  while (j < lines.length) {
    const rawLine = lines[j];
    const propLine = rawLine.trim();
    if (!propLine) {
      j++;
      continue;
    }

    const lineIndent = rawLine.search(/\S/);
    if (lineIndent <= toolIndent) break;

    hasContent = true;

    if (propLine.startsWith('description:')) {
      description = propLine.replace(/^description:\s*"?/, '').replace(/"$/, '');
    }
    if (propLine.startsWith('params:')) {
      const paramsIndent = lineIndent;
      let k = j + 1;
      while (k < lines.length) {
        const paramRaw = lines[k];
        const paramLine = paramRaw.trim();
        if (!paramLine) {
          k++;
          continue;
        }
        const paramIndent = paramRaw.search(/\S/);
        if (paramIndent <= paramsIndent) break;
        const paramMatch = paramLine.match(/^(\w+):\s*(\w+)/);
        if (paramMatch) {
          params.push(`${paramMatch[1]}: ${paramMatch[2]}`);
        }
        k++;
      }
      j = k;
      continue;
    }
    if (propLine.startsWith('returns:')) {
      returns = propLine.replace(/^returns:\s*/, '').trim();
    }

    j++;
  }

  if (!hasContent) return null;

  const paramStr = params.length > 0 ? params.join(', ') : 'input: string';
  const signature = `${name}(${paramStr}) -> ${returns}`;
  const rawBlock = buildSandboxDsl(name, signature, description);

  return {
    parsed: { name, signature, description, toolType: 'sandbox', rawBlock },
    nextIndex: j,
  };
}

function extractToolsFromDsl(dslContent: string): ParsedTool[] {
  const section = extractToolsSection(dslContent);
  if (!section) return [];

  const tools: ParsedTool[] = [];
  const lines = section.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('FROM ')
    ) {
      i++;
      continue;
    }

    if (/^(base_url|auth|timeout|retry):/.test(trimmed)) {
      i++;
      continue;
    }

    const sigMatch = trimmed.match(/^(\w+)\(([^)]*)\)\s*(?:->\s*(.+))?$/);
    if (sigMatch) {
      const tool = parseInlineSignatureTool(lines, i, sigMatch);
      tools.push(tool.parsed);
      i = tool.nextIndex;
      continue;
    }

    const nameBlockMatch = trimmed.match(/^-\s*NAME:\s*(\w+)\s*$/);
    if (nameBlockMatch) {
      const tool = parseNameBlockTool(lines, i, nameBlockMatch[1]);
      tools.push(tool.parsed);
      i = tool.nextIndex;
      continue;
    }

    const lineIndent = line.search(/\S/);
    const simpleListMatch = lineIndent <= 4 ? trimmed.match(/^-\s*(\w+):\s*(.+)$/) : null;
    if (simpleListMatch) {
      tools.push({
        name: simpleListMatch[1],
        signature: `${simpleListMatch[1]}(query: string) -> object`,
        description: simpleListMatch[2].trim(),
        toolType: 'sandbox',
        rawBlock: buildSandboxDsl(
          simpleListMatch[1],
          `${simpleListMatch[1]}(query: string) -> object`,
          simpleListMatch[2].trim(),
        ),
      });
      i++;
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+):\s*$/);
    if (kvMatch && !['session', 'tool_error'].includes(kvMatch[1])) {
      const tool = parseKeyValueTool(lines, i, kvMatch[1]);
      if (tool) {
        tools.push(tool.parsed);
        i = tool.nextIndex;
        continue;
      }
    }

    i++;
  }

  return tools;
}

function buildSandboxDsl(name: string, signature: string, description: string | null): string {
  const mockData = SEED_MOCK_RESPONSES[name];
  const mockCode = mockData
    ? `// Mock: ${name}\nreturn ${JSON.stringify(mockData, null, 2)};`
    : `// Mock: ${name}\nreturn { success: true, message: "${name} executed successfully" };`;

  const codeLines = mockCode
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');

  const parts = [signature];
  if (description) parts.push(`    description: "${description}"`);
  parts.push('    type: sandbox');
  parts.push('    runtime: "javascript"');
  parts.push('    code: |');
  parts.push(codeLines);

  return parts.join('\n');
}

function buildOriginalDsl(
  signature: string,
  propLines: string[],
  toolType: SeedProjectToolType,
): string {
  const parts = [signature];
  // Ensure `type:` is present — the runtime parser needs it to build the correct binding
  const hasTypeDecl = propLines.some((p) => /^type\s*:/.test(p));
  if (!hasTypeDecl) {
    parts.push(`    type: ${toolType}`);
  }
  for (const prop of propLines) {
    parts.push(`    ${prop}`);
  }
  return parts.join('\n');
}

function computeSourceHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function isValidToolName(name: string): boolean {
  return TOOL_NAME_REGEX.test(name);
}

export function collectInlineSeedTools(
  agentSpecs: Array<{ name: string; dslContent: string | null }>,
): SeedProjectTool[] {
  const toolMap = new Map<string, SeedProjectTool>();

  for (const agent of agentSpecs) {
    if (!agent.dslContent) continue;
    const tools = extractToolsFromDsl(agent.dslContent);
    for (const tool of tools) {
      if (!isValidToolName(tool.name) || toolMap.has(tool.name)) {
        continue;
      }
      toolMap.set(tool.name, {
        name: tool.name,
        toolType: tool.toolType,
        description: tool.description,
        dslContent: tool.rawBlock,
        sourceHash: computeSourceHash(tool.rawBlock),
      });
    }
  }

  return [...toolMap.values()];
}
