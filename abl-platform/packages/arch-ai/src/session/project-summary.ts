/**
 * Project Summary Formatter
 *
 * Produces a compact text summary of an Arch project's current state,
 * suitable for LLM context or UI display. The summary is capped at
 * MAX_SUMMARY_CHARS to stay within context budgets.
 */

/** Maximum character length for the formatted summary */
export const MAX_SUMMARY_CHARS = 8000;

/**
 * Input structure for project summary formatting.
 */
export interface ProjectSummaryInput {
  projectName: string;
  description?: string | null;
  agents: Array<{ name: string; type?: string }>;
  tools: Array<{ name: string; toolType?: string }>;
  decisions: Array<{ label: string; detail: string }>;
  channels?: string[];
  language?: string;
}

/**
 * Redact URLs that contain embedded credentials.
 *
 * Matches patterns like `https://user:pass@host` and replaces
 * the credentials portion with `***:***`.
 */
export function redactCredentialUrls(text: string): string {
  return text.replace(/https?:\/\/[^:/?#\s]+:[^@/?#\s]+@/gi, (match) => {
    const protocolEnd = match.indexOf('//') + 2;
    const protocol = match.slice(0, protocolEnd);
    const atIndex = match.lastIndexOf('@');
    return `${protocol}***:***${match.slice(atIndex)}`;
  });
}

/**
 * Format a project summary for LLM context or UI display.
 *
 * The output is always under MAX_SUMMARY_CHARS. If the full summary
 * exceeds the limit, decisions are truncated first, then tools, then agents.
 *
 * @param input - The project summary data
 * @returns A formatted text summary, redacted of credential URLs
 */
export function formatProjectSummary(input: ProjectSummaryInput): string {
  const sections: string[] = [];

  // Header
  sections.push(`# ${input.projectName}`);
  if (input.description) {
    sections.push(redactCredentialUrls(input.description));
  }

  // Metadata
  const meta: string[] = [];
  if (input.channels && input.channels.length > 0) {
    meta.push(`Channels: ${input.channels.join(', ')}`);
  }
  if (input.language) {
    meta.push(`Language: ${input.language}`);
  }
  if (meta.length > 0) {
    sections.push(meta.join(' | '));
  }

  // Agents
  if (input.agents.length > 0) {
    const agentLines = input.agents.map((a) => `- ${a.name}${a.type ? ` (${a.type})` : ''}`);
    sections.push(`## Agents (${input.agents.length})\n${agentLines.join('\n')}`);
  }

  // Tools
  if (input.tools.length > 0) {
    const toolLines = input.tools.map((t) => `- ${t.name}${t.toolType ? ` [${t.toolType}]` : ''}`);
    sections.push(`## Tools (${input.tools.length})\n${toolLines.join('\n')}`);
  }

  // Decisions
  if (input.decisions.length > 0) {
    const decisionLines = input.decisions.map(
      (d) => `- **${redactCredentialUrls(d.label)}**: ${redactCredentialUrls(d.detail)}`,
    );
    sections.push(`## Decisions (${input.decisions.length})\n${decisionLines.join('\n')}`);
  }

  let result = sections.join('\n\n');

  // Truncate if over limit
  if (result.length > MAX_SUMMARY_CHARS) {
    result = result.slice(0, MAX_SUMMARY_CHARS - 3) + '...';
  }

  return result;
}
