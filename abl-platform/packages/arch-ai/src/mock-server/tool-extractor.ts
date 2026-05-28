/**
 * Tool Extractor — parses ABL agent files to extract TOOLS metadata.
 *
 * Primary source: ABL parser from @abl/core
 * Fallback: regex-based extraction for tools not in the parser AST
 */

export interface ToolMeta {
  toolName: string;
  description: string;
  agentName: string;
  method: 'GET' | 'POST';
  parameters: string[];
}

/**
 * Extract tools from a single ABL YAML file.
 * Uses regex since the ABL parser may not expose TOOLS in a structured way.
 */
export function extractToolsFromABL(code: string, agentName: string): ToolMeta[] {
  const tools: ToolMeta[] = [];

  // Find TOOLS: section — capture until next top-level keyword (start of line) or end of string
  const toolsMatch = code.match(/^TOOLS:\s*\n((?:[ \t].*\n?)*)/m);
  if (!toolsMatch) return tools;

  const toolsBlock = toolsMatch[1];

  // Format 1: Arrow-signature entries ("  tool_name(param: type) -> { field: type }")
  // This is the canonical format accepted by the @abl/core parser.
  const arrowEntries = toolsBlock.match(/^\s+(\w+)\(([^)]*)\)\s*->\s*(.+)$/gm);
  if (arrowEntries) {
    for (const entry of arrowEntries) {
      const arrowMatch = entry.trim().match(/^(\w+)\(([^)]*)\)\s*->\s*(.+)$/);
      if (!arrowMatch) continue;
      const toolName = arrowMatch[1];
      const paramsStr = arrowMatch[2];
      const parameters = paramsStr
        .split(',')
        .map((p) => p.trim().split(':')[0].trim())
        .filter(Boolean);

      // Look for a description line indented below this tool
      const descLineMatch = toolsBlock.match(
        new RegExp(`${toolName}\\([^)]*\\).*->.*\\n\\s+description:\\s*['"]([^'"]+)['"]`, 'm'),
      );
      const description = descLineMatch?.[1] ?? `${toolName} tool`;

      tools.push({ toolName, description, agentName, method: 'POST', parameters });
    }
    return tools;
  }

  // Format 2: YAML list items ("  - tool_name")
  const listEntries = toolsBlock.match(/^\s*-\s+(\w+)/gm);
  if (listEntries) {
    for (const entry of listEntries) {
      const toolName = entry.replace(/^\s*-\s+/, '').trim();
      tools.push({
        toolName,
        description: `${toolName} tool`,
        agentName,
        method: 'POST',
        parameters: [],
      });
    }
    return tools;
  }

  // Format 3: nested object entries ("  tool_name:" with description/parameters)
  const objEntries = toolsBlock.match(/^\s{2}(\w+):/gm);
  if (!objEntries) return tools;

  for (const entry of objEntries) {
    const toolName = entry.trim().replace(':', '');

    // Find description for this tool
    const descMatch = toolsBlock.match(
      new RegExp(`${toolName}:[\\s\\S]*?description:\\s*['"]([^'"]+)['"]`, 'm'),
    );
    const description = descMatch?.[1] ?? `${toolName} tool`;

    // Find parameters — case-insensitive to support both PARAMETERS: and parameters:
    const paramSection = toolsBlock.match(
      new RegExp(`${toolName}:[\\s\\S]*?parameters:\\s*\\n([\\s\\S]*?)(?=^\\s{2}\\w|$)`, 'im'),
    );
    const parameters: string[] = [];
    if (paramSection) {
      // Match param names at the first indentation level inside parameters:
      // Filter out known sub-fields (type, description, required) which are
      // nested under each param name in the YAML format
      const PARAM_SUB_FIELDS = ['type', 'description', 'required', 'enum', 'default'];
      const paramLines = paramSection[1].match(/^\s+(\w+):/gm);
      if (paramLines) {
        for (const line of paramLines) {
          const name = line.trim().replace(':', '');
          if (!PARAM_SUB_FIELDS.includes(name)) {
            parameters.push(name);
          }
        }
      }
    }

    // All mocks use POST (per review decision — v1 behavior)
    tools.push({
      toolName,
      description,
      agentName,
      method: 'POST',
      parameters,
    });
  }

  return tools;
}

/**
 * Extract tools from all agent files in a session.
 * Also includes tool names from HANDOFF sections (as these imply tool-like behavior).
 */
export function extractAllTools(
  files: Record<string, { path: string; content: string }>,
  topologyAgents?: Array<{ name: string; tools?: string[] }>,
): ToolMeta[] {
  const allTools: ToolMeta[] = [];

  // Primary: parse each ABL file
  for (const [agentName, file] of Object.entries(files)) {
    const parsed = extractToolsFromABL(file.content, agentName);
    allTools.push(...parsed);
  }

  // Fallback: if parser found nothing, use topology perAgent.tools
  if (allTools.length === 0 && topologyAgents) {
    for (const agent of topologyAgents) {
      if (agent.tools) {
        for (const toolName of agent.tools) {
          allTools.push({
            toolName,
            description: `${toolName} tool for ${agent.name}`,
            agentName: agent.name,
            method: 'POST',
            parameters: [],
          });
        }
      }
    }
  }

  return allTools;
}
