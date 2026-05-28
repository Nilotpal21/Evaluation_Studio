/**
 * Tool File Parser
 *
 * Parses .tools.abl files that define reusable tool collections
 * with shared defaults (base_url, auth, timeout, etc.)
 */

import type {
  AgentTool,
  ToolParam,
  ToolType,
  ToolAuthType,
  HttpBindingAST,
  McpBindingAST,
  LambdaBindingAST,
  SandboxBindingAST,
  ToolCompactionConfigAST,
  ToolHintsAST,
} from '../types/agent-based.js';
import type { ToolFileDefaults, ToolFileDocument } from '../types/tool-file.js';
import { parseToolParams, parseToolReturn } from './tool-parser-utils.js';

interface ParseError {
  line: number;
  column: number;
  message: string;
}

interface ParserState {
  lines: string[];
  currentLine: number;
  errors: ParseError[];
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function stripQuotes(val: string): string {
  return val.replace(/^["']|["']$/g, '');
}

/**
 * Parse a .tools.abl file
 */
export function parseToolFile(content: string): {
  document: ToolFileDocument | null;
  errors: ParseError[];
} {
  const state: ParserState = {
    lines: content.split('\n'),
    currentLine: 0,
    errors: [],
  };

  // Skip to TOOLS: section
  while (state.currentLine < state.lines.length) {
    const trimmed = state.lines[state.currentLine].trim();
    if (trimmed === 'TOOLS:') {
      state.currentLine++;
      break;
    }
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }
    state.errors.push({
      line: state.currentLine + 1,
      column: 0,
      message: `Expected TOOLS: section, got: ${trimmed}`,
    });
    state.currentLine++;
  }

  if (state.currentLine >= state.lines.length && state.errors.length === 0) {
    state.errors.push({
      line: 1,
      column: 0,
      message: 'No TOOLS: section found',
    });
    return { document: null, errors: state.errors };
  }

  const defaults: ToolFileDefaults = {};
  const tools: AgentTool[] = [];

  // Parse defaults and tool definitions
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    // Check if this is a tool definition (has parentheses)
    const toolMatch = trimmed.match(/^(\w+)\(([^)]*)\)(?:\s*->\s*(.+))?$/);
    if (toolMatch) {
      const [, name, paramsStr, returnStr] = toolMatch;
      const parameters = parseToolParams(paramsStr);
      const returns = parseToolReturn(returnStr?.trim() || 'object');
      const tool: AgentTool = { name, parameters, returns };

      const toolIndent = getIndent(line);
      state.currentLine++;

      // Parse tool properties
      const props = parseToolProperties(state, toolIndent);
      if (props.type) tool.type = props.type;
      if (props.description) tool.description = props.description;
      if (props.hints) tool.hints = props.hints;
      if (props.httpBinding) tool.httpBinding = props.httpBinding;
      if (props.mcpBinding) tool.mcpBinding = props.mcpBinding;
      if (props.lambdaBinding) tool.lambdaBinding = props.lambdaBinding;
      if (props.sandboxBinding) tool.sandboxBinding = props.sandboxBinding;
      if (props.compaction) tool.compaction = props.compaction;
      if (props.storeResult !== undefined) tool.storeResult = props.storeResult;
      if (props.onResult) tool.onResult = props.onResult;
      if (props.onError) tool.onError = props.onError;
      if (props.confirmation) tool.confirmation = props.confirmation;
      if (props.piiAccess) tool.piiAccess = props.piiAccess;
      if (props.authProfile) tool.authProfile = props.authProfile;
      if (props.authJit !== undefined) tool.authJit = props.authJit;
      if (props.consent) tool.consent = props.consent;
      if (props.connection) tool.connection = props.connection;
      if (props.parameterEnrichments) {
        applyParameterEnrichments(tool.parameters, props.parameterEnrichments);
      }

      tools.push(tool);
      continue;
    }

    if (/^[^\s#].*\([^)]*\)/.test(trimmed)) {
      state.errors.push({
        line: state.currentLine + 1,
        column: getIndent(line),
        message: `Invalid tool signature '${trimmed}'. Use a tool name made of letters, numbers, and underscores, for example payments__check_refund_eligibility(...).`,
      });
      state.currentLine++;
      continue;
    }

    // Handle bare sub-block keys at defaults level (e.g., "headers:" with no value)
    const bareDefaultMatch = trimmed.match(/^(\w+):\s*$/);
    if (bareDefaultMatch) {
      const bareKey = bareDefaultMatch[1].toLowerCase();
      if (bareKey === 'headers') {
        const headersIndent = getIndent(line);
        state.currentLine++;
        defaults.headers = parseHeaders(state, headersIndent);
        continue;
      }
    }

    // Check for top-level defaults (no parentheses, key: value format)
    const defaultMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (defaultMatch) {
      const [, key, value] = defaultMatch;
      switch (key.toLowerCase()) {
        case 'base_url':
          defaults.baseUrl = stripQuotes(value);
          break;
        case 'auth':
          defaults.auth = value as ToolAuthType;
          break;
        case 'timeout':
          defaults.timeout = parseInt(value, 10);
          break;
        case 'retry':
          defaults.retry = parseInt(value, 10);
          break;
        case 'retry_delay':
          defaults.retryDelay = parseInt(value, 10);
          break;
        case 'rate_limit':
          defaults.rateLimit = parseInt(value, 10);
          break;
        case 'headers': {
          // Parse inline headers or start multi-line block
          const headersIndent = getIndent(line);
          state.currentLine++;
          defaults.headers = parseHeaders(state, headersIndent);
          continue;
        }
      }
      state.currentLine++;
      continue;
    }

    // Break if we hit something unrecognized at top level
    if (getIndent(line) === 0 && trimmed.match(/^[A-Z_]+:$/)) {
      break;
    }

    state.currentLine++;
  }

  return {
    document: { defaults, tools },
    errors: state.errors,
  };
}

interface ToolPropertiesResult {
  type?: ToolType;
  description?: string;
  hints?: ToolHintsAST;
  httpBinding?: HttpBindingAST;
  mcpBinding?: McpBindingAST;
  lambdaBinding?: LambdaBindingAST;
  sandboxBinding?: SandboxBindingAST;
  compaction?: ToolCompactionConfigAST;
  storeResult?: boolean;
  onResult?: { set: Record<string, string> };
  onError?: { set: Record<string, string> };
  contextAccess?: { read: string[]; write: string[] };
  confirmation?: {
    require: 'always' | 'never' | 'when_side_effects';
    immutableParams?: string[];
    consentRequiredIn?: 'conversation' | 'explicit_prompt';
    consentScope?: string[];
    consentAction?: string;
    consentFallback?: 'explicit_prompt' | 'block';
  };
  piiAccess?: 'tools' | 'user' | 'logs' | 'llm';
  /** Auth profile reference name */
  authProfile?: string;
  /** Whether this tool supports JIT authentication */
  authJit?: boolean;
  /** Consent mode: preflight or inline */
  consent?: 'preflight' | 'inline';
  /** Connection mode: per_user or shared */
  connection?: 'per_user' | 'shared';
  /** Enrichments parsed from a `parameters:` block — keyed by param name */
  parameterEnrichments?: Map<string, Partial<ToolParam>>;
}

/**
 * Parse indented tool properties after a tool signature
 */
export function parseToolProperties(state: ParserState, toolIndent: number): ToolPropertiesResult {
  const result: ToolPropertiesResult = {};
  const hints: ToolHintsAST = {};
  let hasHints = false;

  // Collect raw properties first
  let toolType: ToolType | undefined;
  let endpoint: string | undefined;
  let method: string | undefined;
  let auth: ToolAuthType | undefined;
  let authConfig: HttpBindingAST['authConfig'] | undefined;
  let timeout: number | undefined;
  let retry: number | undefined;
  let retryDelay: number | undefined;
  let rateLimit: number | undefined;
  let headers: Record<string, string> | undefined;
  let queryParams: Record<string, string> | undefined;
  let bodyType: HttpBindingAST['bodyType'] | undefined;
  let circuitBreaker: { threshold: number; resetMs: number } | undefined;
  let server: string | undefined;
  let toolName: string | undefined;
  let funcName: string | undefined;
  let runtime: string | undefined;
  let code: string | undefined;
  let bodyTemplate: string | undefined;
  let memoryMb: number | undefined;
  let storeResult: boolean | undefined;
  let onResult: { set: Record<string, string> } | undefined;
  let onError: { set: Record<string, string> } | undefined;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // Stop if we hit a line with less or equal indentation to the tool definition
    if (trimmed && indent <= toolIndent) {
      break;
    }

    // Skip empty lines
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    // Handle bare sub-block keys (e.g., "headers:" with no inline value)
    // that start an indented block. The main regex requires content after
    // the colon, so these need special-case handling before the regex.
    const bareBlockMatch = trimmed.match(/^(\w+):\s*$/);
    if (bareBlockMatch) {
      const bareKey = bareBlockMatch[1].toLowerCase();
      if (bareKey === 'headers') {
        const headersIndent = indent;
        state.currentLine++;
        headers = parseHeaders(state, headersIndent);
        continue;
      } else if (bareKey === 'query_params') {
        const qpIndent = indent;
        state.currentLine++;
        queryParams = parseHeaders(state, qpIndent);
        continue;
      } else if (bareKey === 'auth_config') {
        const authConfigIndent = indent;
        state.currentLine++;
        authConfig = parseAuthConfig(state, authConfigIndent);
        continue;
      } else if (bareKey === 'on_result') {
        state.currentLine++;
        onResult = parseToolEventBlock(state, indent);
        continue;
      } else if (bareKey === 'on_error') {
        state.currentLine++;
        onError = parseToolEventBlock(state, indent);
        continue;
      } else if (bareKey === 'context_access') {
        state.currentLine++;
        result.contextAccess = parseContextAccessBlock(state, indent);
        continue;
      } else if (bareKey === 'compaction') {
        state.currentLine++;
        result.compaction = parseToolCompactionBlock(state, indent);
        continue;
      } else if (bareKey === 'parameters') {
        state.currentLine++;
        result.parameterEnrichments = parseParametersBlock(state, indent);
        continue;
      }
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key.toLowerCase()) {
        // Common
        case 'type':
          toolType = value as ToolType;
          break;
        case 'description':
          if (value.trim() === '|') {
            // Pipe block — collect indented lines (same pattern as code/body)
            const descLines: string[] = [];
            const descBlockIndent = indent;
            while (state.currentLine + 1 < state.lines.length) {
              const nextLine = state.lines[state.currentLine + 1];
              const nextTrimmed = nextLine.trim();
              const nextIndent = getIndent(nextLine);
              if (nextTrimmed && nextIndent <= descBlockIndent) break;
              if (!nextTrimmed) {
                descLines.push('');
              } else {
                descLines.push(nextLine.substring(descBlockIndent + 2));
              }
              state.currentLine++;
            }
            result.description = descLines.join('\n').trim();
          } else {
            result.description = stripQuotes(value);
          }
          break;
        case 'timeout':
          timeout = parseInt(value, 10);
          break;

        // HTTP
        case 'endpoint':
          endpoint = stripQuotes(value);
          break;
        case 'method':
          method = value.toUpperCase();
          break;
        case 'auth':
          auth = value as ToolAuthType;
          break;
        case 'retry':
          retry = parseInt(value, 10);
          break;
        case 'retry_delay':
          retryDelay = parseInt(value, 10);
          break;
        case 'rate_limit':
          rateLimit = parseInt(value, 10);
          break;
        case 'circuit_breaker': {
          // Parse: {threshold: 5, resetMs: 30000}
          const cbMatch = value.match(/\{\s*threshold:\s*(\d+)\s*,\s*resetMs:\s*(\d+)\s*\}/);
          if (cbMatch) {
            circuitBreaker = {
              threshold: parseInt(cbMatch[1], 10),
              resetMs: parseInt(cbMatch[2], 10),
            };
          }
          break;
        }
        case 'headers': {
          const headersIndent = indent;
          state.currentLine++;
          headers = parseHeaders(state, headersIndent);
          continue;
        }

        // MCP
        case 'server':
          server = stripQuotes(value);
          break;
        case 'tool':
          toolName = stripQuotes(value);
          break;

        // Lambda
        case 'function':
          funcName = stripQuotes(value);
          break;
        case 'runtime':
          runtime = stripQuotes(value);
          break;

        // Sandbox
        case 'code':
          if (value.trim() === '|') {
            // Pipe block — collect indented lines
            const codeLines: string[] = [];
            const codeBlockIndent = indent;
            while (state.currentLine + 1 < state.lines.length) {
              const nextLine = state.lines[state.currentLine + 1];
              const nextTrimmed = nextLine.trim();
              const nextIndent = getIndent(nextLine);
              if (nextTrimmed && nextIndent <= codeBlockIndent) break;
              if (!nextTrimmed) {
                codeLines.push('');
              } else {
                codeLines.push(nextLine.substring(codeBlockIndent + 2));
              } // strip indent
              state.currentLine++;
            }
            code = codeLines.join('\n').trim();
          } else {
            code = stripQuotes(value);
          }
          break;
        case 'body':
        case 'body_template':
          if (value.trim() === '|') {
            const bodyLines: string[] = [];
            const bodyBlockIndent = indent;
            while (state.currentLine + 1 < state.lines.length) {
              const nextLine = state.lines[state.currentLine + 1];
              const nextTrimmed = nextLine.trim();
              const nextIndent = getIndent(nextLine);
              if (nextTrimmed && nextIndent <= bodyBlockIndent) break;
              if (!nextTrimmed) {
                bodyLines.push('');
              } else {
                bodyLines.push(nextLine.substring(bodyBlockIndent + 2));
              }
              state.currentLine++;
            }
            bodyTemplate = bodyLines.join('\n').trim();
          } else {
            bodyTemplate = stripQuotes(value);
          }
          break;
        case 'body_type':
          if (['json', 'form', 'xml', 'text'].includes(value)) {
            bodyType = value as HttpBindingAST['bodyType'];
          }
          break;
        case 'memory_mb':
          memoryMb = parseInt(value, 10);
          break;

        // Tool hints (legacy)
        case 'cacheable':
          hints.cacheable = value === 'true';
          hasHints = true;
          break;
        case 'latency':
          hints.latency = value as 'fast' | 'medium' | 'slow';
          hasHints = true;
          break;
        case 'side_effects':
          hints.side_effects = value === 'true' || value === 'yes';
          hasHints = true;
          break;
        case 'requires_auth':
          hints.requires_auth = value === 'true' || value === 'yes';
          hasHints = true;
          break;
        case 'store_result':
          storeResult = value.toLowerCase() === 'true';
          break;
        case 'confirm':
          if (!result.confirmation) {
            result.confirmation = { require: 'never' };
          }
          result.confirmation.require = value as 'always' | 'never' | 'when_side_effects';
          break;
        case 'immutable':
          if (!result.confirmation) {
            result.confirmation = { require: 'always' };
          }
          result.confirmation.immutableParams = parseInlineStringList(value);
          break;
        case 'consent_required_in':
          if (!result.confirmation) {
            result.confirmation = { require: 'when_side_effects' };
          }
          if (stripQuotes(value) === 'conversation' || stripQuotes(value) === 'explicit_prompt') {
            result.confirmation.consentRequiredIn = stripQuotes(value) as
              | 'conversation'
              | 'explicit_prompt';
          }
          break;
        case 'consent_scope':
          if (!result.confirmation) {
            result.confirmation = { require: 'when_side_effects' };
          }
          result.confirmation.consentScope = parseInlineStringList(value);
          break;
        case 'consent_action':
          if (!result.confirmation) {
            result.confirmation = { require: 'when_side_effects' };
          }
          result.confirmation.consentAction = stripQuotes(value);
          break;
        case 'consent_fallback':
          if (!result.confirmation) {
            result.confirmation = { require: 'when_side_effects' };
          }
          if (stripQuotes(value) === 'explicit_prompt' || stripQuotes(value) === 'block') {
            result.confirmation.consentFallback = stripQuotes(value) as 'explicit_prompt' | 'block';
          }
          break;
        case 'pii_access':
          result.piiAccess = value as 'tools' | 'user' | 'logs' | 'llm';
          break;
        case 'auth_profile':
          result.authProfile = stripQuotes(value);
          break;
        case 'auth_jit':
          result.authJit = value.toLowerCase() === 'true';
          break;
        case 'consent':
          result.consent = value as 'preflight' | 'inline';
          break;
        case 'connection':
          result.connection = value as 'per_user' | 'shared';
          break;
      }
    }

    state.currentLine++;
  }

  // Set type
  if (toolType) {
    result.type = toolType;
  }

  // Build bindings based on type
  if (toolType === 'http' && endpoint) {
    result.httpBinding = {
      endpoint,
      method: (method || 'GET') as HttpBindingAST['method'],
      auth,
      authConfig,
      timeout,
      retry,
      retryDelay,
      headers,
      queryParams,
      bodyType,
      bodyTemplate,
      rateLimit,
      circuitBreaker,
    };
  } else if (toolType === 'mcp' && server) {
    result.mcpBinding = {
      server,
      tool: toolName,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    };
  } else if (toolType === 'lambda' && funcName) {
    result.lambdaBinding = {
      function: funcName,
      runtime,
      timeout,
    };
  } else if (toolType === 'sandbox') {
    result.sandboxBinding = {
      runtime: (runtime || 'javascript') as 'javascript' | 'python',
      code,
      timeout,
      memoryMb,
    };
  }

  // Set timeout hint even for non-http types
  if (timeout && !result.httpBinding) {
    hints.timeout = timeout;
    hasHints = true;
  }

  if (hasHints) {
    result.hints = hints;
  }

  if (storeResult !== undefined) {
    result.storeResult = storeResult;
  }
  if (onResult) {
    result.onResult = onResult;
  }
  if (onError) {
    result.onError = onError;
  }

  return result;
}

function parseInlineStringList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((entry) => stripQuotes(entry.trim()))
    .filter(Boolean);
}

function parseToolCompactionBlock(
  state: ParserState,
  parentIndent: number,
): ToolCompactionConfigAST {
  const compaction: ToolCompactionConfigAST = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) break;
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key.toLowerCase()) {
        case 'essential_fields':
          compaction.essential_fields = parseInlineStringList(value);
          break;
        case 'max_description_length':
          compaction.max_description_length = parseInt(value, 10);
          break;
      }
    }

    state.currentLine++;
  }

  return compaction;
}

/**
 * Parse ON_RESULT / ON_ERROR event block.
 * Expects a `SET:` header followed by indented `variable = expression` lines.
 */
/**
 * Parse CONTEXT_ACCESS block with READ: and WRITE: sub-properties.
 * Syntax:
 *   CONTEXT_ACCESS:
 *     READ: [var1, var2, var3]
 *     WRITE: [var4, var5]
 */
function parseContextAccessBlock(
  state: ParserState,
  parentIndent: number,
): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) break;
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    const readMatch = trimmed.match(/^READ:\s*\[([^\]]*)\]$/i);
    const writeMatch = trimmed.match(/^WRITE:\s*\[([^\]]*)\]$/i);

    if (readMatch) {
      read.push(
        ...readMatch[1]
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean),
      );
    } else if (writeMatch) {
      write.push(
        ...writeMatch[1]
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean),
      );
    }

    state.currentLine++;
  }

  return { read, write };
}

function parseToolEventBlock(
  state: ParserState,
  parentIndent: number,
): { set: Record<string, string> } | undefined {
  const set: Record<string, string> = {};

  // Look for SET: header
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) break;
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    if (trimmed.toUpperCase() === 'SET:') {
      const setIndent = indent;
      state.currentLine++;
      // Parse indented "variable = expression" lines
      while (state.currentLine < state.lines.length) {
        const setLine = state.lines[state.currentLine];
        const setTrimmed = setLine.trim();
        const setLineIndent = getIndent(setLine);
        if (!setTrimmed || setLineIndent <= setIndent) break;
        const setMatch = setTrimmed.match(/^([\w.]+)\s*=\s*(.+)$/);
        if (setMatch) {
          set[setMatch[1]] = setMatch[2].trim();
        }
        state.currentLine++;
      }
      continue;
    }

    state.currentLine++;
  }

  return Object.keys(set).length > 0 ? { set } : undefined;
}

/**
 * Parse auth_config nested block into HttpBindingAST['authConfig']
 */
function parseAuthConfig(state: ParserState, parentIndent: number): HttpBindingAST['authConfig'] {
  const config: NonNullable<HttpBindingAST['authConfig']> = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) break;
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    const match = trimmed.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      switch (key.toLowerCase()) {
        case 'token_url':
          config.tokenUrl = stripQuotes(value);
          break;
        case 'client_id':
          config.clientId = stripQuotes(value);
          break;
        case 'client_secret':
          config.clientSecret = stripQuotes(value);
          break;
        case 'scopes':
          config.scopes = stripQuotes(value);
          break;
        case 'header_name':
          config.headerName = stripQuotes(value);
          break;
        case 'api_key':
          config.apiKey = stripQuotes(value);
          break;
        case 'token':
          config.token = stripQuotes(value);
          break;
        case 'provider':
          config.provider = stripQuotes(value);
          break;
      }
    }
    state.currentLine++;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Apply parameter enrichments from a `parameters:` block to signature-parsed params.
 */
export function applyParameterEnrichments(
  params: ToolParam[],
  enrichments: Map<string, Partial<ToolParam>>,
): void {
  for (const [name, enrichment] of enrichments) {
    const param = params.find((p) => p.name === name);
    if (param) {
      if (enrichment.type !== undefined) param.type = enrichment.type;
      if (enrichment.description !== undefined) param.description = enrichment.description;
      if (enrichment.required !== undefined) param.required = enrichment.required;
      if (enrichment.items !== undefined) param.items = enrichment.items;
      if (enrichment.properties !== undefined) param.properties = enrichment.properties;
    }
  }
}

/**
 * Parse a `parameters:` block that enriches signature-parsed params with
 * descriptions, nested `items:` (for array-of-object), and `properties:` (for object types).
 *
 * Returns a Map keyed by parameter name with partial ToolParam enrichments.
 */
function parseParametersBlock(
  state: ParserState,
  parentIndent: number,
): Map<string, Partial<ToolParam>> {
  const enrichments = new Map<string, Partial<ToolParam>>();

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) break;
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    // Each child at this level is a parameter name (e.g., "queries:")
    const paramNameMatch = trimmed.match(/^(\w+):\s*$/);
    if (paramNameMatch) {
      const paramName = paramNameMatch[1];
      const paramIndent = indent;
      state.currentLine++;
      const enrichment = parseParamSubKeys(state, paramIndent);
      enrichments.set(paramName, enrichment);
      continue;
    }

    state.currentLine++;
  }

  return enrichments;
}

/**
 * Parse sub-keys for a single parameter inside a `parameters:` block.
 * Handles: type, description, required, items:, properties:
 */
function parseParamSubKeys(state: ParserState, paramIndent: number): Partial<ToolParam> {
  const enrichment: Partial<ToolParam> = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= paramIndent) break;
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    // Bare block keys: items: or properties:
    const bareMatch = trimmed.match(/^(\w+):\s*$/);
    if (bareMatch) {
      const subKey = bareMatch[1].toLowerCase();
      if (subKey === 'items' || subKey === 'properties') {
        const blockIndent = indent;
        state.currentLine++;
        const fields = parseNestedFields(state, blockIndent);
        if (subKey === 'items') {
          enrichment.items = {
            type: 'object',
            properties: fields,
          };
        } else {
          enrichment.properties = fields;
        }
        continue;
      }
    }

    // Key-value sub-properties: type, description, required
    const kvMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      switch (key.toLowerCase()) {
        case 'type':
          enrichment.type = stripQuotes(value);
          break;
        case 'description':
          enrichment.description = stripQuotes(value);
          break;
        case 'required':
          enrichment.required = value.toLowerCase() === 'true';
          break;
      }
    }

    state.currentLine++;
  }

  return enrichment;
}

/**
 * Parse nested field definitions (used by both `items:` and `properties:` blocks).
 * Each field is a name followed by indented type/description/required sub-keys.
 */
function parseNestedFields(state: ParserState, parentIndent: number): ToolParam[] {
  const fields: ToolParam[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) break;
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    // Each child at this level is a field name (e.g., "query:")
    const fieldNameMatch = trimmed.match(/^(\w+):\s*$/);
    if (fieldNameMatch) {
      const fieldName = fieldNameMatch[1];
      const fieldIndent = indent;
      state.currentLine++;

      // Parse field sub-keys
      const field: ToolParam = {
        name: fieldName,
        type: 'string',
        required: false,
      };

      while (state.currentLine < state.lines.length) {
        const fLine = state.lines[state.currentLine];
        const fTrimmed = fLine.trim();
        const fIndent = getIndent(fLine);

        if (fTrimmed && fIndent <= fieldIndent) break;
        if (!fTrimmed) {
          state.currentLine++;
          continue;
        }

        const fKvMatch = fTrimmed.match(/^(\w+):\s*(.+)$/);
        if (fKvMatch) {
          const [, fKey, fValue] = fKvMatch;
          switch (fKey.toLowerCase()) {
            case 'type':
              field.type = stripQuotes(fValue);
              break;
            case 'description':
              field.description = stripQuotes(fValue);
              break;
            case 'required':
              field.required = fValue.toLowerCase() === 'true';
              break;
          }
        }

        state.currentLine++;
      }

      fields.push(field);
      continue;
    }

    state.currentLine++;
  }

  return fields;
}

/**
 * Parse indented key: "value" header lines
 */
function parseHeaders(state: ParserState, parentIndent: number): Record<string, string> {
  const headers: Record<string, string> = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    const headerMatch = trimmed.match(/^([\w-]+):\s*(.+)$/);
    if (headerMatch) {
      headers[headerMatch[1]] = stripQuotes(headerMatch[2]);
    }

    state.currentLine++;
  }

  return headers;
}
