/**
 * Tool Stub Synthesizer
 *
 * Generates .tools.abl DSL content from tool signatures extracted
 * from agent TOOLS: sections. Used to auto-create tool stubs in the
 * Tool Library during import when a tool is declared in an agent but
 * no corresponding .tools.abl file exists.
 */

import type { AgentDeclaredTool } from './tool-signature-extractor.js';

/**
 * Synthesize a tool DSL stub from an agent-declared tool signature.
 *
 * Produces a standalone tool DSL string with the full type signature,
 * description, and a placeholder HTTP endpoint for the user to configure.
 *
 * @param tool - Extracted tool signature from agent DSL
 * @returns Tool DSL content string
 */
export function synthesizeToolDsl(tool: AgentDeclaredTool): string {
  const lines: string[] = [];

  // Signature line
  lines.push(tool.signature);

  // Description
  const desc = tool.description ?? `Auto-created from agent DSL import (${tool.sourceAgent})`;
  const escaped = desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  lines.push(`  description: "${escaped}"`);

  // Default type and placeholder endpoint
  lines.push('  type: http');
  lines.push('  endpoint: "https://TODO-configure-endpoint"');
  lines.push('  method: POST');

  return lines.join('\n') + '\n';
}
