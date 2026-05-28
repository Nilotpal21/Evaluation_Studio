/**
 * Tool Import Resolver
 *
 * Resolves FROM "path" USE: tool1, tool2 imports by parsing
 * the referenced .tools.abl file and merging defaults.
 */

import type { AgentTool, ToolAuthType } from '../types/agent-based.js';
import type { ToolImport } from '../types/agent-based.js';
import type { ToolFileDefaults } from '../types/tool-file.js';
import { parseToolFile } from './tool-file-parser.js';
import * as path from 'path';

/**
 * Resolve tool imports from .tools.abl files.
 *
 * @param imports - Array of import declarations from the agent file
 * @param basePath - Directory path of the importing agent file (for relative resolution)
 * @param fileReader - Function that reads file content by absolute path (returns null if not found)
 */
export function resolveToolImports(
  imports: ToolImport[],
  basePath: string,
  fileReader: (path: string) => string | null,
): { tools: AgentTool[]; errors: string[] } {
  const tools: AgentTool[] = [];
  const errors: string[] = [];

  for (const imp of imports) {
    // Resolve relative path
    const resolvedPath = path.resolve(basePath, imp.source);

    // Read the file
    const content = fileReader(resolvedPath);
    if (content === null) {
      errors.push(`Tool file not found: ${imp.source} (resolved to ${resolvedPath})`);
      continue;
    }

    // Parse the tool file
    const result = parseToolFile(content);
    if (!result.document) {
      errors.push(`Failed to parse tool file: ${imp.source}`);
      for (const err of result.errors) {
        errors.push(`  ${imp.source}:${err.line}: ${err.message}`);
      }
      continue;
    }

    const { defaults, tools: fileTtools } = result.document;

    // Find requested tools
    for (const toolName of imp.toolNames) {
      const found = fileTtools.find((t) => t.name === toolName);
      if (!found) {
        errors.push(
          `Tool "${toolName}" not found in ${imp.source}. Available: ${fileTtools.map((t) => t.name).join(', ')}`,
        );
        continue;
      }

      // Merge defaults into the tool
      const merged = mergeDefaults(found, defaults);
      merged.sourceFile = imp.source;
      tools.push(merged);
    }
  }

  return { tools, errors };
}

/**
 * Merge file-level defaults into a tool definition.
 * Tool-level properties take precedence over defaults.
 */
function mergeDefaults(tool: AgentTool, defaults: ToolFileDefaults): AgentTool {
  const merged = { ...tool };

  // Only merge for HTTP tools (or tools without a type that have HTTP-like properties)
  if (merged.type === 'http' && merged.httpBinding) {
    const binding = { ...merged.httpBinding };

    // Prepend base_url to relative endpoints
    if (defaults.baseUrl && binding.endpoint && !binding.endpoint.startsWith('http')) {
      binding.endpoint = defaults.baseUrl + binding.endpoint;
    }

    // Apply defaults (tool-level takes precedence)
    if (defaults.auth && binding.auth === undefined) {
      binding.auth = defaults.auth;
    }
    if (defaults.timeout !== undefined && binding.timeout === undefined) {
      binding.timeout = defaults.timeout;
    }
    if (defaults.retry !== undefined && binding.retry === undefined) {
      binding.retry = defaults.retry;
    }
    if (defaults.retryDelay !== undefined && binding.retryDelay === undefined) {
      binding.retryDelay = defaults.retryDelay;
    }
    if (defaults.rateLimit !== undefined && binding.rateLimit === undefined) {
      binding.rateLimit = defaults.rateLimit;
    }
    if (defaults.headers) {
      binding.headers = { ...defaults.headers, ...(binding.headers || {}) };
    }

    merged.httpBinding = binding;
  }

  return merged;
}
