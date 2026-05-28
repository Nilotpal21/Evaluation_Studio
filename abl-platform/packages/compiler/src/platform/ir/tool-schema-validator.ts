/**
 * Tool Schema Validator
 *
 * Validates tool definitions at compile time for completeness, correctness, and safety.
 * Catches configuration errors before they reach production runtime.
 *
 * Usage:
 *   const result = validateToolDefinitions(compilationOutput.agents['main'].tools);
 *   if (!result.valid) { log errors; }
 */

import type { ToolDefinition } from './schema.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ToolValidationEntry {
  tool: string;
  field: string;
  message: string;
}

export interface ToolValidationResult {
  valid: boolean;
  errors: ToolValidationEntry[];
  warnings: ToolValidationEntry[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

// MAX_SIZE: immutable validation constants (not runtime collections)
const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_MCP_TRANSPORTS = new Set(['stdio', 'sse', 'http']);
const VALID_SANDBOX_RUNTIMES = new Set(['javascript', 'python']);
const VALID_TOOL_TYPES = new Set(['http', 'mcp', 'sandbox', 'connector', 'searchai', 'workflow']);

// ─── Validator ─────────────────────────────────────────────────────────────

/**
 * Validate an array of tool definitions for correctness.
 *
 * Returns `{ valid: true }` if all tools pass validation, or
 * `{ valid: false, errors, warnings }` with structured issues.
 */
export function validateToolDefinitions(tools: ToolDefinition[]): ToolValidationResult {
  const errors: ToolValidationEntry[] = [];
  const warnings: ToolValidationEntry[] = [];
  const seenNames = new Set<string>();

  for (const tool of tools) {
    // 1. Required fields
    if (!tool.name || tool.name.trim() === '') {
      errors.push({ tool: '<unnamed>', field: 'name', message: 'Tool must have a name' });
      continue;
    }

    if (!tool.description || tool.description.trim() === '') {
      warnings.push({
        tool: tool.name,
        field: 'description',
        message: 'Tool should have a description for LLM tool selection',
      });
    }

    // 2. Duplicate names
    if (seenNames.has(tool.name)) {
      errors.push({
        tool: tool.name,
        field: 'name',
        message: `Duplicate tool name: "${tool.name}"`,
      });
    }
    seenNames.add(tool.name);

    // 3. Tool type validation
    if (tool.tool_type && !VALID_TOOL_TYPES.has(tool.tool_type)) {
      errors.push({
        tool: tool.name,
        field: 'tool_type',
        message: `Invalid tool type: "${tool.tool_type}". Must be one of: ${Array.from(VALID_TOOL_TYPES).join(', ')}`,
      });
    }

    // 4. Type-specific validation
    if (tool.tool_type === 'http') {
      validateHttpTool(tool, errors, warnings);
    } else if (tool.tool_type === 'mcp') {
      validateMcpTool(tool, errors, warnings);
    } else if (tool.tool_type === 'sandbox') {
      validateSandboxTool(tool, errors, warnings);
    } else if (tool.tool_type === 'workflow') {
      validateWorkflowTool(tool, errors, warnings);
    }

    // 5. Parameter validation
    if (tool.parameters) {
      for (const param of tool.parameters) {
        if (!param.name || param.name.trim() === '') {
          errors.push({
            tool: tool.name,
            field: 'parameters',
            message: 'Parameter must have a name',
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── Type-specific validators ──────────────────────────────────────────────

function validateHttpTool(
  tool: ToolDefinition,
  errors: ToolValidationEntry[],
  warnings: ToolValidationEntry[],
): void {
  if (!tool.http_binding) {
    errors.push({
      tool: tool.name,
      field: 'http_binding',
      message: 'HTTP tool must have http_binding',
    });
    return;
  }

  const binding = tool.http_binding;

  if (!binding.endpoint || binding.endpoint.trim() === '') {
    errors.push({
      tool: tool.name,
      field: 'http_binding.endpoint',
      message: 'HTTP tool must have an endpoint URL',
    });
  } else {
    // Validate URL format (skip template URLs with placeholders)
    if (!binding.endpoint.includes('{{') && !binding.endpoint.includes('{')) {
      try {
        new URL(binding.endpoint);
      } catch {
        errors.push({
          tool: tool.name,
          field: 'http_binding.endpoint',
          message: `Invalid endpoint URL: "${binding.endpoint}"`,
        });
      }
    }
  }

  if (!binding.method || !VALID_HTTP_METHODS.has(binding.method)) {
    errors.push({
      tool: tool.name,
      field: 'http_binding.method',
      message: `Invalid HTTP method: "${binding.method}"`,
    });
  }

  if (!binding.auth) {
    warnings.push({
      tool: tool.name,
      field: 'http_binding.auth',
      message: 'HTTP tool has no auth configuration',
    });
  }

  // SOAP-specific validation
  if (binding.protocol === 'soap' && !binding.soap_version) {
    errors.push({
      tool: tool.name,
      field: 'http_binding.soap_version',
      message: 'soap_version is required when protocol is soap',
    });
  }

  if (binding.protocol !== undefined && binding.protocol !== 'soap' && binding.soap_action) {
    errors.push({
      tool: tool.name,
      field: 'http_binding.soap_action',
      message: 'soap_action can only be set when protocol is soap',
    });
  }

  // SOAP requests must use POST. The executor's body-rendering branch is gated
  // on method !== 'GET', so a SOAP+GET tool would silently bypass envelope
  // wrapping, Content-Type override, and SOAPAction header injection.
  if (binding.protocol === 'soap' && binding.method && binding.method !== 'POST') {
    errors.push({
      tool: tool.name,
      field: 'http_binding.method',
      message: 'method must be POST when protocol is soap',
    });
  }
}

function validateMcpTool(
  tool: ToolDefinition,
  errors: ToolValidationEntry[],
  _warnings: ToolValidationEntry[],
): void {
  if (!tool.mcp_binding) {
    errors.push({
      tool: tool.name,
      field: 'mcp_binding',
      message: 'MCP tool must have mcp_binding',
    });
    return;
  }

  if (!tool.mcp_binding.server || tool.mcp_binding.server.trim() === '') {
    errors.push({
      tool: tool.name,
      field: 'mcp_binding.server',
      message: 'MCP tool must reference a server',
    });
  }

  if (!tool.mcp_binding.tool || tool.mcp_binding.tool.trim() === '') {
    errors.push({
      tool: tool.name,
      field: 'mcp_binding.tool',
      message: 'MCP tool must reference a tool name on the server',
    });
  }

  // Validate inline server config transport if present
  if (tool.mcp_binding.server_config) {
    const cfg = tool.mcp_binding.server_config;
    if (!VALID_MCP_TRANSPORTS.has(cfg.transport)) {
      errors.push({
        tool: tool.name,
        field: 'mcp_binding.server_config.transport',
        message: `Invalid MCP transport: "${cfg.transport}"`,
      });
    }

    // SSE/HTTP transports require a URL
    if ((cfg.transport === 'sse' || cfg.transport === 'http') && !cfg.url) {
      errors.push({
        tool: tool.name,
        field: 'mcp_binding.server_config.url',
        message: `MCP ${cfg.transport} transport requires a url`,
      });
    }

    // stdio transport requires a command
    if (cfg.transport === 'stdio' && !cfg.command) {
      errors.push({
        tool: tool.name,
        field: 'mcp_binding.server_config.command',
        message: 'MCP stdio transport requires a command',
      });
    }
  }
}

function validateSandboxTool(
  tool: ToolDefinition,
  errors: ToolValidationEntry[],
  _warnings: ToolValidationEntry[],
): void {
  if (!tool.sandbox_binding) {
    errors.push({
      tool: tool.name,
      field: 'sandbox_binding',
      message: 'Sandbox tool must have sandbox_binding',
    });
    return;
  }

  if (!tool.sandbox_binding.runtime || !VALID_SANDBOX_RUNTIMES.has(tool.sandbox_binding.runtime)) {
    errors.push({
      tool: tool.name,
      field: 'sandbox_binding.runtime',
      message: `Invalid sandbox runtime: "${tool.sandbox_binding.runtime}". Must be javascript or python`,
    });
  }
}

function validateWorkflowTool(
  tool: ToolDefinition,
  errors: ToolValidationEntry[],
  _warnings: ToolValidationEntry[],
): void {
  if (!tool.workflow_binding) {
    errors.push({
      tool: tool.name,
      field: 'workflow_binding',
      message: 'Workflow tool must have workflow_binding',
    });
    return;
  }

  if (!tool.workflow_binding.workflowId || tool.workflow_binding.workflowId.trim() === '') {
    errors.push({
      tool: tool.name,
      field: 'workflow_binding.workflowId',
      message: 'Workflow tool must have a non-empty workflowId',
    });
  }

  if (!tool.workflow_binding.triggerId || tool.workflow_binding.triggerId.trim() === '') {
    errors.push({
      tool: tool.name,
      field: 'workflow_binding.triggerId',
      message: 'Workflow tool must have a non-empty triggerId',
    });
  }
}
