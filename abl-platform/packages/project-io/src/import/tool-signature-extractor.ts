/**
 * Tool Signature Extractor
 *
 * Extracts tool signatures from agent DSL TOOLS: sections.
 * Used during import to auto-create tool stubs for tools declared
 * in agents but not present as .tools.abl files.
 */

import { parseAgentBasedABL } from '@abl/core/parser';

/** Maximum agent files to parse for tool extraction */
const MAX_AGENT_FILES = 1000;

/** Lightweight param type matching the parser's AgentTool.parameters[n] shape */
interface ParsedToolParam {
  name: string;
  type: string;
  required: boolean;
}

/** Lightweight return type matching the parser's AgentTool.returns shape */
interface ParsedToolReturn {
  type: string;
  fields?: Record<string, ParsedToolReturn>;
  items?: ParsedToolReturn;
  optional?: boolean;
}

/** Lightweight tool type matching the parser's doc.tools[n] shape */
interface ParsedAgentTool {
  name: string;
  description?: string;
  parameters: ParsedToolParam[];
  returns: ParsedToolReturn;
}

export interface AgentDeclaredTool {
  /** Tool name from the TOOLS: section */
  name: string;
  /** Full signature string: name(params) -> returnType */
  signature: string;
  /** Description from the tool declaration */
  description: string | null;
  /** Parameter list from the parsed tool */
  parameters: ParsedToolParam[];
  /** Return type from the parsed tool */
  returns: ParsedToolReturn;
  /** Which agent file declared this tool */
  sourceAgent: string;
}

export interface ToolSignatureExtractionResult {
  /** All unique tool declarations found across agents */
  tools: AgentDeclaredTool[];
  /** Parse errors encountered */
  errors: Array<{ file: string; message: string }>;
}

/**
 * Format a ToolReturn into a DSL-compatible string.
 */
function formatReturnType(ret: ParsedToolReturn): string {
  if (ret.fields && Object.keys(ret.fields).length > 0) {
    const fieldEntries = Object.entries(ret.fields)
      .map(([key, val]) => {
        const optMark = val.optional ? '?' : '';
        return `${key}${optMark}: ${formatReturnType(val)}`;
      })
      .join(', ');
    return `{${fieldEntries}}`;
  }
  if (ret.items) {
    return `${formatReturnType(ret.items)}[]`;
  }
  return ret.type;
}

/**
 * Format a ToolParam into a DSL-compatible string.
 */
function formatParam(param: ParsedToolParam): string {
  const optMark = param.required ? '' : '?';
  return `${param.name}${optMark}: ${param.type}`;
}

/**
 * Build a full tool signature string from parsed tool metadata.
 */
function buildSignature(tool: ParsedAgentTool): string {
  const params = tool.parameters.map(formatParam).join(', ');
  const returns = formatReturnType(tool.returns);
  return `${tool.name}(${params}) -> ${returns}`;
}

/**
 * Extract tool signatures declared in agent DSL TOOLS: sections.
 *
 * Parses each agent file, collects declared tools, deduplicates by name
 * (keeping the richest signature — most parameters).
 *
 * @param agentFiles - Map of file path -> agent DSL content
 * @returns Extracted tool signatures and any parse errors
 */
export function extractToolSignaturesFromAgents(
  agentFiles: Map<string, string>,
): ToolSignatureExtractionResult {
  const toolMap = new Map<string, AgentDeclaredTool>();
  const errors: Array<{ file: string; message: string }> = [];
  let count = 0;

  for (const [filePath, content] of agentFiles) {
    if (count >= MAX_AGENT_FILES) break;
    count++;

    try {
      const result = parseAgentBasedABL(content);

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          errors.push({ file: filePath, message: `Line ${err.line}: ${err.message}` });
        }
      }

      if (!result.document?.tools) continue;

      for (const tool of result.document.tools) {
        const existing = toolMap.get(tool.name);

        // Keep richest signature (most parameters) when same tool declared in multiple agents
        if (!existing || tool.parameters.length > existing.parameters.length) {
          toolMap.set(tool.name, {
            name: tool.name,
            signature: buildSignature(tool),
            description: tool.description ?? null,
            parameters: tool.parameters,
            returns: tool.returns,
            sourceAgent: filePath,
          });
        }
      }
    } catch (err) {
      errors.push({
        file: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tools: [...toolMap.values()], errors };
}
