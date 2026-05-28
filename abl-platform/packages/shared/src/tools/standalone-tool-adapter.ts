/**
 * Standalone Tool DSL Adapter
 *
 * Converts standalone .tool.abl files (Format A: TOOL header) into
 * signature-first dslContent (Format B) for the existing parsing pipeline.
 *
 * Supports both sandbox and HTTP tool types.
 *
 * Format A (standalone sandbox):
 *   TOOL: <tool_name>
 *   TYPE: sandbox
 *   RUNTIME: javascript
 *   ...
 *   CODE: |
 *     ...
 *
 * Format A (standalone HTTP):
 *   TOOL: <tool_name>
 *   TYPE: http
 *   METHOD: POST
 *   ENDPOINT: "https://example.com/api"
 *   AUTH: custom
 *   HEADERS:
 *     Auth: "{{env.TOKEN}}"
 *   BODY: |
 *     {"query": "{{input.query}}"}
 *
 * Format B (dslContent):
 *   tool_name(param: type) -> object
 *     type: http
 *     endpoint: https://example.com/api
 *     method: POST
 *     ...
 */

import {
  parseDslProperties,
  buildSandboxBindingFromProps,
  buildHttpBindingFromProps,
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  parseSignatureLine,
  parseDslParamMetadata,
  parseOptionalRuntimeNumber,
  parseReturnTypeString,
  parseDslToolCompaction,
} from './dsl-property-parser.js';
import type { ToolDefinitionLocal, ToolParameterLocal } from './resolve-tool-implementations.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface ParsedStandaloneParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

// ─── Format A Parser ──────────────────────────────────────────────────────

/**
 * Parse the PARAMETERS: block from a standalone .tool.abl file.
 */
function parseStandaloneParameters(content: string): ParsedStandaloneParam[] {
  const lines = content.split('\n');
  const params: ParsedStandaloneParam[] = [];
  let inParams = false;
  let paramsIndent = -1;
  let currentParam: ParsedStandaloneParam | null = null;
  let paramIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (inParams) {
      if (trimmed && indent <= paramsIndent) break;
      if (!trimmed) continue;

      if (currentParam && indent > paramIndent) {
        const match = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
        if (match) {
          const [, key, rawValue] = match;
          const value = rawValue.replace(/^["']|["']$/g, '').trim();
          if (key === 'type') currentParam.type = value;
          else if (key === 'required') currentParam.required = value === 'true';
          else if (key === 'description') currentParam.description = value;
        }
      } else {
        const nameMatch = trimmed.match(/^(\w+)\s*:\s*$/);
        if (nameMatch) {
          currentParam = { name: nameMatch[1], type: 'string', required: false };
          paramIndent = indent;
          params.push(currentParam);
        }
      }
    } else if (trimmed === 'PARAMETERS:') {
      inParams = true;
      paramsIndent = indent;
    }
  }

  return params;
}

/**
 * Parse top-level key: value headers from a standalone .tool.abl file.
 * Reads uppercase keys (TOOL, TYPE, ENDPOINT, METHOD, AUTH, etc.).
 */
function parseStandaloneHeaders(content: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const blockStarters = ['PARAMETERS:', 'HEADERS:', 'QUERY_PARAMS:', 'AUTH_CONFIG:'];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Stop at nested block starters or pipe blocks
    if (
      blockStarters.includes(trimmed) ||
      trimmed.startsWith('CODE:') ||
      trimmed.startsWith('BODY:')
    )
      break;

    const match = trimmed.match(/^([A-Z_]+)\s*:\s*(.+)$/);
    if (match) {
      headers[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return headers;
}

/**
 * Extract a named nested block (e.g., HEADERS:, QUERY_PARAMS:, AUTH_CONFIG:)
 * from a standalone .tool.abl file. Returns key-value pairs.
 */
function extractStandaloneNestedBlock(
  content: string,
  blockName: string,
): Array<{ key: string; value: string }> {
  const lines = content.split('\n');
  const entries: Array<{ key: string; value: string }> = [];
  let inBlock = false;
  let blockIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (inBlock) {
      if (trimmed && indent <= blockIndent) break;
      if (!trimmed) continue;
      const match = trimmed.match(/^([\w-]+)\s*:\s*(.+)$/);
      if (match) {
        entries.push({ key: match[1], value: match[2].replace(/^["']|["']$/g, '').trim() });
      }
    } else if (trimmed === `${blockName}:`) {
      inBlock = true;
      blockIndent = indent;
    }
  }

  return entries;
}

/**
 * Extract a named pipe block (e.g., BODY: |) from a standalone .tool.abl file.
 */
function extractStandalonePipeBlock(content: string, blockName: string): string | null {
  const lines = content.split('\n');
  let capturing = false;
  let baseIndent = -1;
  const codeLines: string[] = [];

  for (const line of lines) {
    if (capturing) {
      if (baseIndent === -1 && line.trim()) {
        baseIndent = line.length - line.trimStart().length;
      }
      if (line.trim() === '' || line.length - line.trimStart().length >= baseIndent) {
        codeLines.push(baseIndent > 0 ? line.slice(baseIndent) : line);
      } else if (line.trim()) {
        break;
      } else {
        /* v8 ignore start */
        codeLines.push('');
        /* v8 ignore stop */
      }
    } else if (line.trimStart().startsWith(`${blockName}:`) && line.trimStart().endsWith('|')) {
      capturing = true;
    }
  }

  return codeLines.length > 0 ? codeLines.join('\n').trimEnd() : null;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Convert a standalone .tool.abl file (Format A) to signature-first dslContent (Format B).
 *
 * Throws if the content does not contain a TOOL: header line.
 */
export function convertStandaloneToolDSL(content: string): string {
  const headers = parseStandaloneHeaders(content);
  const toolName = headers.TOOL;
  if (!toolName) {
    throw new Error('Missing TOOL: header in standalone tool DSL');
  }

  const params = parseStandaloneParameters(content);

  // Build signature line: name(param1: type1, param2?: type2) -> object
  const paramParts = params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`);
  const signatureLine = `${toolName}(${paramParts.join(', ')}) -> object`;

  // Build property lines
  const propLines: string[] = [];
  if (headers.TYPE) propLines.push(`  type: ${headers.TYPE.toLowerCase()}`);
  if (headers.DESCRIPTION) propLines.push(`  description: "${headers.DESCRIPTION}"`);
  // HTTP-specific properties
  if (headers.ENDPOINT) propLines.push(`  endpoint: ${headers.ENDPOINT}`);
  if (headers.METHOD) propLines.push(`  method: ${headers.METHOD}`);
  if (headers.AUTH) propLines.push(`  auth: ${headers.AUTH.toLowerCase()}`);
  // Sandbox-specific properties
  if (headers.RUNTIME) propLines.push(`  runtime: ${headers.RUNTIME.toLowerCase()}`);
  if (headers.TIMEOUT) propLines.push(`  timeout: ${headers.TIMEOUT}`);
  if (headers.MEMORY_MB) propLines.push(`  memory_mb: ${headers.MEMORY_MB}`);

  // Build params metadata block
  const paramMetaLines: string[] = [];
  const hasParamMeta = params.some((p) => p.description);
  if (hasParamMeta) {
    paramMetaLines.push('  params:');
    for (const p of params) {
      if (p.description) {
        paramMetaLines.push(`    ${p.name}:`);
        paramMetaLines.push(`      description: "${p.description}"`);
      }
    }
  }

  // Build nested blocks (HEADERS → headers, QUERY_PARAMS → query_params, AUTH_CONFIG → auth_config)
  const nestedLines: string[] = [];
  const nestedBlockMap: Record<string, string> = {
    HEADERS: 'headers',
    QUERY_PARAMS: 'query_params',
    AUTH_CONFIG: 'auth_config',
  };
  for (const [formatAName, formatBName] of Object.entries(nestedBlockMap)) {
    const entries = extractStandaloneNestedBlock(content, formatAName);
    if (entries.length > 0) {
      nestedLines.push(`  ${formatBName}:`);
      for (const { key, value } of entries) {
        nestedLines.push(`    ${key}: ${value}`);
      }
    }
  }

  // Build pipe blocks (CODE → code, BODY → body)
  const pipeLines: string[] = [];
  const pipeBlockMap: Record<string, string> = { CODE: 'code', BODY: 'body' };
  for (const [formatAName, formatBName] of Object.entries(pipeBlockMap)) {
    const block = extractStandalonePipeBlock(content, formatAName);
    if (block) {
      pipeLines.push(`  ${formatBName}: |`);
      for (const line of block.split('\n')) {
        pipeLines.push(line ? `    ${line}` : '');
      }
    }
  }

  return [signatureLine, ...propLines, ...paramMetaLines, ...nestedLines, ...pipeLines].join('\n');
}

/**
 * Load standalone .tool.abl DSL strings and resolve them into ToolDefinitionLocal entries.
 *
 * Returns a map of tool name -> [ToolDefinitionLocal] (single-element array per tool).
 * This map is compatible with compileToResolvedAgent's resolvedToolImplementations parameter.
 */
export function loadToolDSLsAsResolved(toolDSLs: string[]): Map<string, ToolDefinitionLocal[]> {
  const result = new Map<string, ToolDefinitionLocal[]>();

  for (const rawDSL of toolDSLs) {
    const dslContent = convertStandaloneToolDSL(rawDSL);
    const sig = parseSignatureLine(dslContent);
    const props = parseDslProperties(dslContent);
    const paramMeta = parseDslParamMetadata(dslContent);
    const compaction = parseDslToolCompaction(dslContent);
    const toolType = (props.type || 'sandbox') as
      | 'http'
      | 'sandbox'
      | 'mcp'
      | 'searchai'
      | 'workflow';

    // Build binding based on type
    let sandbox_binding: ToolDefinitionLocal['sandbox_binding'];
    let http_binding: ToolDefinitionLocal['http_binding'];
    let searchai_binding: ToolDefinitionLocal['searchai_binding'];
    let workflow_binding: ToolDefinitionLocal['workflow_binding'];
    if (toolType === 'sandbox') {
      sandbox_binding = buildSandboxBindingFromProps(props, dslContent);
    } else if (toolType === 'http') {
      http_binding = buildHttpBindingFromProps(props, dslContent);
    } else if (toolType === 'searchai') {
      searchai_binding = buildSearchAIBindingFromProps(props);
    } else if (toolType === 'workflow') {
      workflow_binding = buildWorkflowBindingFromProps(props);
    }

    const toolDef: ToolDefinitionLocal = {
      name: dslContent.split('(')[0].trim(),
      description: props.description || '',
      parameters: sig.parameters.map((p) => {
        const meta = paramMeta.get(p.name);
        const param: ToolParameterLocal = {
          name: p.name,
          type: p.type,
          required: p.required,
          ...(meta?.description && { description: meta.description }),
        };
        return param;
      }),
      returns: parseReturnTypeString(sig.returnType),
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: true,
        side_effects: true,
        requires_auth: false,
        timeout: parseOptionalRuntimeNumber(props.timeout, 'Tool hint timeout'),
      },
      tool_type: toolType,
      sandbox_binding,
      http_binding,
      searchai_binding,
      workflow_binding,
      compaction,
    };

    result.set(toolDef.name, [toolDef]);
  }

  return result;
}
