/**
 * Tool Extractor
 *
 * Parses .tools.abl file contents into individual tool metadata suitable
 * for persisting as ProjectTool documents. Each tool in a tool file becomes
 * a separate ExtractedTool with its own sourceHash computed from the stored
 * standalone tool DSL content.
 */

import { createHash } from 'node:crypto';
import { parseToolFile } from '@abl/core/parser';
import type { ToolFileDocument } from '@abl/core/types';
import type { ProjectToolType } from '@agent-platform/database';
import { canonicalizeToolFileContent } from '../tool-file-format.js';

/** Tool entry from a parsed ToolFileDocument */
type ParsedTool = ToolFileDocument['tools'][number];
type ToolFileDefaults = ToolFileDocument['defaults'];

// ─── Types ────────────────────────────────────────────────────────────────

export interface ExtractedTool {
  /** Tool name from the DSL signature */
  name: string;
  /** Resolved tool type for ProjectTool storage */
  toolType: ProjectToolType;
  /** Human-readable description (if present in DSL) */
  description: string | null;
  /** Full file content that contains this tool */
  dslContent: string;
  /** Relative path of the source .tools.abl file */
  sourceFile: string;
  /** SHA-256 hex digest (64 chars) of the file content */
  sourceHash: string;
}

export interface ToolExtractionError {
  /** Source file path */
  sourceFile: string;
  /** Error message */
  message: string;
}

export interface ToolExtractionWarning {
  /** Source file path */
  sourceFile: string;
  /** Warning code */
  code: string;
  /** Human-readable warning */
  message: string;
}

export interface ToolExtractionResult {
  /** Successfully extracted tools */
  tools: ExtractedTool[];
  /** Parse errors keyed by source file */
  errors: ToolExtractionError[];
  /** Non-blocking normalization / fidelity warnings */
  warnings: ToolExtractionWarning[];
  /** Files whose tool set could not be trusted completely */
  incompleteFiles: string[];
}

// ─── Mapping from DSL ToolType to ProjectToolType ─────────────────────────

const TOOL_TYPE_MAP: Record<string, ProjectToolType> = {
  http: 'http',
  mcp: 'mcp',
  sandbox: 'sandbox',
  searchai: 'searchai',
  workflow: 'workflow',
  // lambda and async_webhook are not valid ProjectToolTypes; default to 'http'
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Infer the ProjectToolType from a parsed AgentTool.
 *
 * Priority:
 * 1. Explicit `type` field on the tool
 * 2. Presence of binding objects (sandboxBinding, mcpBinding, httpBinding)
 * 3. Default to 'http'
 */
export function inferToolType(tool: ParsedTool): ProjectToolType {
  // 1. Explicit type field
  if (tool.type) {
    const mapped = TOOL_TYPE_MAP[tool.type];
    if (mapped) return mapped;
    // For unmapped DSL types (lambda, async_webhook), fall through to binding check
  }

  // 2. Check bindings
  if (tool.sandboxBinding) return 'sandbox';
  if (tool.mcpBinding) return 'mcp';
  if (tool.httpBinding) return 'http';

  // 3. Default
  return 'http';
}

/**
 * Compute full 64-character SHA-256 hex digest of content.
 */
function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function quoteDslValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function joinBaseUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

function isRelativeEndpoint(endpoint: string): boolean {
  if (endpoint.includes('{{')) return false;
  return !/^[a-z][a-z\d+.-]*:\/\//i.test(endpoint);
}

interface PropertyLine {
  lineIndex: number;
  value: string;
}

function parseStandalonePropertyLines(lines: string[]): Map<string, PropertyLine> {
  const props = new Map<string, PropertyLine>();

  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    props.set(key, { lineIndex: i, value: stripQuotes(rawValue) });
  }

  return props;
}

function setOrAppendProperty(
  lines: string[],
  props: Map<string, PropertyLine>,
  key: string,
  value: string,
): void {
  const existing = props.get(key);
  const rendered = `  ${key}: ${value}`;
  if (existing) {
    lines[existing.lineIndex] = rendered;
    props.set(key, { lineIndex: existing.lineIndex, value: stripQuotes(value) });
    return;
  }

  props.set(key, { lineIndex: lines.length, value: stripQuotes(value) });
  lines.push(rendered);
}

function findNestedBlock(
  lines: string[],
  key: string,
): { startIndex: number; endIndex: number; indent: number } | null {
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const blockMatch = trimmed.match(new RegExp(`^${key}\\s*:\\s*$`));
    if (!blockMatch) continue;

    const indent = line.length - trimmed.length;
    let endIndex = i + 1;
    while (endIndex < lines.length) {
      const next = lines[endIndex];
      const nextTrimmed = next.trim();
      if (nextTrimmed) {
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
      }
      endIndex++;
    }

    return { startIndex: i, endIndex, indent };
  }

  return null;
}

function materializeDefaultHeaders(lines: string[], headers?: Record<string, string>): void {
  if (!headers || Object.keys(headers).length === 0) return;

  const block = findNestedBlock(lines, 'headers');
  if (!block) {
    lines.push('  headers:');
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`    ${key}: ${quoteDslValue(value)}`);
    }
    return;
  }

  const existing = new Set<string>();
  for (let i = block.startIndex + 1; i < block.endIndex; i++) {
    const match = lines[i].trimStart().match(/^([\w.:-]+)\s*:/);
    if (match) existing.add(match[1]);
  }

  const additions = Object.entries(headers)
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => `${' '.repeat(block.indent + 2)}${key}: ${quoteDslValue(value)}`);

  if (additions.length > 0) {
    lines.splice(block.endIndex, 0, ...additions);
  }
}

function materializeToolFileDefaults(
  toolDsl: string,
  defaults: ToolFileDefaults,
  toolType: ProjectToolType,
): string {
  if (toolType !== 'http') return toolDsl;

  const lines = toolDsl.split('\n');
  const props = parseStandalonePropertyLines(lines);

  const endpoint = props.get('endpoint')?.value;
  if (defaults.baseUrl && endpoint && isRelativeEndpoint(endpoint)) {
    setOrAppendProperty(
      lines,
      props,
      'endpoint',
      quoteDslValue(joinBaseUrl(defaults.baseUrl, endpoint)),
    );
  }

  if (defaults.auth && !props.has('auth')) {
    setOrAppendProperty(lines, props, 'auth', defaults.auth);
  }
  if (defaults.timeout !== undefined && !props.has('timeout')) {
    setOrAppendProperty(lines, props, 'timeout', String(defaults.timeout));
  }
  if (defaults.retry !== undefined && !props.has('retry')) {
    setOrAppendProperty(lines, props, 'retry', String(defaults.retry));
  }
  if (defaults.retryDelay !== undefined && !props.has('retry_delay')) {
    setOrAppendProperty(lines, props, 'retry_delay', String(defaults.retryDelay));
  }
  if (defaults.rateLimit !== undefined && !props.has('rate_limit')) {
    setOrAppendProperty(lines, props, 'rate_limit', String(defaults.rateLimit));
  }

  materializeDefaultHeaders(lines, defaults.headers);

  return lines.join('\n');
}

// ─── Per-Tool DSL Extraction ──────────────────────────────────────────────

/**
 * Extract individual tool DSL sections from a .tools.abl file.
 *
 * The UI parser (parseDslToToolForm) expects dslContent to start with
 * the tool signature line: `toolName(params) -> returnType`.
 * But .tools.abl files wrap tools inside a `TOOLS:` block with shared defaults.
 *
 * This function finds each tool signature line and extracts that tool's
 * complete DSL (signature + indented properties) as a standalone string.
 */
function extractToolDslSections(content: string): Map<string, string> {
  const lines = content.split('\n');
  const sections = new Map<string, string>();

  // Find tool signature lines: `  toolName(params) [-> returnType]`
  const toolLineIndices: Array<{ name: string; lineIndex: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const match = trimmed.match(/^(\w+)\s*\(.*\)(?:\s*->\s*.+)?$/);
    if (match) {
      toolLineIndices.push({ name: match[1], lineIndex: i });
    }
  }

  for (let t = 0; t < toolLineIndices.length; t++) {
    const { name, lineIndex } = toolLineIndices[t];
    const sigLine = lines[lineIndex];
    const sigIndent = sigLine.length - sigLine.trimStart().length;

    // Collect the signature line + all following lines indented deeper
    const toolLines: string[] = [sigLine.trimStart()]; // signature with no leading indent

    for (let j = lineIndex + 1; j < lines.length; j++) {
      const line = lines[j];
      const trimmed = line.trim();

      // Empty line — include if we haven't hit the next tool
      if (!trimmed) {
        // Check if the next non-empty line is still part of this tool
        let nextNonEmpty = j + 1;
        while (nextNonEmpty < lines.length && !lines[nextNonEmpty].trim()) {
          nextNonEmpty++;
        }
        if (nextNonEmpty < lines.length) {
          const nextIndent = lines[nextNonEmpty].length - lines[nextNonEmpty].trimStart().length;
          if (nextIndent <= sigIndent && lines[nextNonEmpty].trim()) {
            break; // next non-empty line is at tool level or above
          }
        }
        continue; // skip empty lines within the tool
      }

      const lineIndent = line.length - trimmed.length;
      if (lineIndent <= sigIndent) {
        break; // same or lower indentation = next tool or section
      }

      // Strip the tool's base indentation so properties have 2-space indent
      const stripped = line.substring(sigIndent);
      toolLines.push(stripped);
    }

    sections.set(name, toolLines.join('\n'));
  }

  return sections;
}

// ─── Main ─────────────────────────────────────────────────────────────────

/**
 * Extract individual tool metadata from a map of .tools.abl file contents.
 *
 * Each tool's dslContent is the standalone single-tool DSL (starting with
 * the signature line), compatible with the UI parser (parseDslToToolForm).
 *
 * @param toolFiles - Map of file path -> file content
 * @returns Extraction result with tools and any parse errors
 */
export function extractToolsFromFiles(toolFiles: Map<string, string>): ToolExtractionResult {
  const tools: ExtractedTool[] = [];
  const errors: ToolExtractionError[] = [];
  const warnings: ToolExtractionWarning[] = [];
  const incompleteFiles = new Set<string>();

  for (const [filePath, content] of toolFiles) {
    try {
      const canonical = canonicalizeToolFileContent(content);
      const { document, errors: parseErrors } = parseToolFile(canonical.content);

      if (canonical.normalized) {
        warnings.push({
          sourceFile: filePath,
          code: 'W_LEGACY_TOOL_FILE_NORMALIZED',
          message: 'Normalized legacy single-tool DSL into canonical TOOLS: format for import',
        });
      }

      if (parseErrors.length > 0) {
        incompleteFiles.add(filePath);
        for (const err of parseErrors) {
          errors.push({
            sourceFile: filePath,
            message: `Line ${err.line}: ${err.message}`,
          });
        }
      }

      if (!document) {
        incompleteFiles.add(filePath);
        continue;
      }

      if (document.tools.length === 0 && content.trim() !== '') {
        incompleteFiles.add(filePath);
        errors.push({
          sourceFile: filePath,
          message: 'No tool definitions found in tool file',
        });
        continue;
      }

      const dslSections = extractToolDslSections(canonical.content);

      for (const agentTool of document.tools) {
        // Use the extracted per-tool DSL, falling back to full file if extraction missed
        const toolType = inferToolType(agentTool);
        const toolDsl = materializeToolFileDefaults(
          dslSections.get(agentTool.name) ?? content,
          document.defaults,
          toolType,
        );

        tools.push({
          name: agentTool.name,
          toolType,
          description: agentTool.description ?? null,
          dslContent: toolDsl,
          sourceFile: filePath,
          sourceHash: computeHash(toolDsl),
        });
      }
    } catch (err) {
      incompleteFiles.add(filePath);
      errors.push({
        sourceFile: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tools, errors, warnings, incompleteFiles: [...incompleteFiles] };
}
