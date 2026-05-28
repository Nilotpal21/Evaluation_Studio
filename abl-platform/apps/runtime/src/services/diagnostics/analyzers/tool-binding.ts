/**
 * Tool Binding Analyzer
 *
 * Loads an agent's DSL content and checks whether each tool referenced
 * by the agent has a corresponding ProjectTool record in the database.
 * Reports unbound tools as warnings.
 */

import { createLogger } from '@abl/compiler/platform';
import type { Analyzer, DiagnosticContext, DiagnosticFinding } from '../types.js';

const log = createLogger('diag-tool-binding');

/** Naive regex to extract tool names from the TOOLS section of DSL content. */
function extractToolNames(dslContent: string): string[] {
  const toolNames: string[] = [];

  // Match lines like "- tool_name" or "TOOL tool_name" or "use tool_name"
  // Also match TOOLS: [...] array-style declarations
  const toolsSectionMatch = dslContent.match(/TOOLS\s*[:\s]\s*([\s\S]*?)(?:\n[A-Z]|\n---|\Z)/i);
  if (toolsSectionMatch) {
    const section = toolsSectionMatch[1];
    // Extract list items like "- tool_name" or bare names on lines
    const lineMatches = section.matchAll(/^\s*[-*]\s*(\w+)/gm);
    for (const m of lineMatches) {
      toolNames.push(m[1]);
    }
  }

  // Also look for inline tool references like "tools: [tool_a, tool_b]"
  const inlineMatch = dslContent.match(/tools\s*:\s*\[([^\]]+)\]/i);
  if (inlineMatch) {
    const names = inlineMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
    for (const name of names) {
      if (name && /^\w+$/.test(name)) {
        toolNames.push(name);
      }
    }
  }

  // Deduplicate
  return [...new Set(toolNames)];
}

export class ToolBindingAnalyzer implements Analyzer {
  name = 'tool-binding';
  category = 'infra' as const;

  async analyze(context: DiagnosticContext): Promise<DiagnosticFinding[]> {
    const findings: DiagnosticFinding[] = [];
    const { tenantId, projectId, agentName } = context;

    if (!agentName) {
      findings.push({
        analyzer: this.name,
        severity: 'info',
        code: 'NO_AGENT_SPECIFIED',
        title: 'No agent specified',
        detail: 'Tool binding analysis requires an agent name to check tool references.',
        suggestion: 'Provide an agent name to analyze tool bindings.',
        evidence: [],
      });
      return findings;
    }

    try {
      // Load agent record to get DSL content
      const { ProjectAgent } = await import('@agent-platform/database/models');
      const agent = await ProjectAgent.findOne({ tenantId, projectId, name: agentName }).lean();

      if (!agent) {
        findings.push({
          analyzer: this.name,
          severity: 'warning',
          code: 'AGENT_NOT_FOUND',
          title: 'Agent not found in database',
          detail: `No ProjectAgent record found for agent "${agentName}" in project "${projectId}".`,
          suggestion:
            'Verify the agent name is correct and that the agent has been saved to the project.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Agent lookup',
              data: { tenantId, projectId, agentName, found: false },
            },
          ],
        });
        return findings;
      }

      const agentDoc = agent as Record<string, unknown>;
      const dslContent = typeof agentDoc.dslContent === 'string' ? agentDoc.dslContent : null;

      if (!dslContent) {
        findings.push({
          analyzer: this.name,
          severity: 'info',
          code: 'NO_DSL_CONTENT',
          title: 'Agent has no DSL content',
          detail: 'The agent record exists but has no DSL content to analyze for tool references.',
          suggestion: 'Ensure the agent DSL has been compiled and saved.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Agent record',
              data: { agentName, hasDslContent: false },
            },
          ],
        });
        return findings;
      }

      // Extract tool names from DSL
      const toolNames = extractToolNames(dslContent);

      if (toolNames.length === 0) {
        findings.push({
          analyzer: this.name,
          severity: 'info',
          code: 'TOOLS_OK',
          title: 'No tools declared',
          detail: 'The agent DSL does not reference any tools.',
          suggestion: 'No action needed.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Tool extraction',
              data: { agentName, toolCount: 0 },
            },
          ],
        });
        return findings;
      }

      // Check each tool against ProjectTool collection
      const { ProjectTool } = await import('@agent-platform/database/models');
      const unboundTools: string[] = [];
      const boundTools: string[] = [];

      for (const toolName of toolNames) {
        try {
          const projectTool = await ProjectTool.findOne({
            tenantId,
            projectId,
            name: toolName,
          }).lean();

          if (projectTool) {
            boundTools.push(toolName);
          } else {
            unboundTools.push(toolName);
          }
        } catch (err) {
          log.warn('Failed to check ProjectTool', {
            error: err instanceof Error ? err.message : String(err),
            toolName,
          });
          unboundTools.push(toolName);
        }
      }

      // Report unbound tools
      if (unboundTools.length > 0) {
        findings.push({
          analyzer: this.name,
          severity: 'warning',
          code: 'UNBOUND_TOOL',
          title: `${unboundTools.length} tool(s) declared but not found in project`,
          detail: `The following tools are referenced in the agent DSL but have no matching ProjectTool record: ${unboundTools.join(', ')}`,
          suggestion:
            'Create the missing tools in the project, or remove the references from the agent DSL.',
          evidence: unboundTools.map((name) => ({
            type: 'config' as const,
            label: `Unbound tool: ${name}`,
            data: { toolName: name, bound: false },
          })),
        });
      }

      // Report success if all tools are bound
      if (unboundTools.length === 0) {
        findings.push({
          analyzer: this.name,
          severity: 'info',
          code: 'TOOLS_OK',
          title: 'All tools are bound',
          detail: `All ${boundTools.length} tool(s) declared in the agent DSL have matching ProjectTool records.`,
          suggestion: 'No action needed.',
          evidence: boundTools.map((name) => ({
            type: 'config' as const,
            label: `Bound tool: ${name}`,
            data: { toolName: name, bound: true },
          })),
        });
      }
    } catch (err) {
      log.error('Tool binding analysis failed', {
        error: err instanceof Error ? err.message : String(err),
        agentName,
        projectId,
      });
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        code: 'ANALYSIS_ERROR',
        title: 'Tool binding analysis encountered an error',
        detail: err instanceof Error ? err.message : String(err),
        suggestion: 'Check database connectivity and try again.',
        evidence: [],
      });
    }

    return findings;
  }
}
