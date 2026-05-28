/**
 * DSL Property Parser
 *
 * Shared utilities for parsing tool DSL content. Extracted from
 * resolve-tool-implementations.ts to eliminate duplication between:
 * - resolve-tool-implementations.ts (compile-time resolver)
 * - load-project-tools-as-ir.ts (runtime loader)
 * - project-tool-validator.ts (Phase 5 trial compile)
 *
 * All three consumers now import from this single module.
 */

import type { McpServerConfigForIR } from '../types/mcp-server.js';
import { parseDslNestedBlock, parseDslDeepNestedBlock } from './parse-dsl-to-tool-form.js';
import {
  normalizeHttpAuthConfig,
  type HttpAuthConfigInput,
} from './http-auth-config-normalizer.js';

// ─── Local IR types (mirror @abl/compiler shapes) ────────────────────────────
// Declared locally to avoid circular dep: shared → compiler → shared

export type ToolAuthTypeIR =
  | 'none'
  | 'api_key'
  | 'bearer'
  | 'oauth2_client'
  | 'oauth2_user'
  | 'custom';

export type ConfigRuntimeNumericTemplate = `{{config.${string}}}`;
export type RuntimeNumericValue = number | ConfigRuntimeNumericTemplate;

export interface HttpBindingIRLocal {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth: { type: ToolAuthTypeIR; config?: Record<string, unknown> };
  body_type?: 'json' | 'form' | 'xml' | 'text';
  timeout_ms?: RuntimeNumericValue;
  retry?: { count: RuntimeNumericValue; delay_ms: RuntimeNumericValue };
  rate_limit_per_minute?: RuntimeNumericValue;
  circuit_breaker?: { threshold: RuntimeNumericValue; reset_ms: RuntimeNumericValue };
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  body_template?: string;
  /** Protocol discriminator — undefined or 'rest' means REST behavior */
  protocol?: 'rest' | 'soap';
  soap_version?: '1.1' | '1.2';
  soap_action?: string;
  on_soap_fault?: 'error' | 'data';
  on_http_error?: 'error' | 'data';
}

export interface SandboxBindingIRLocal {
  runtime: 'javascript' | 'python';
  code_content: string;
  timeout_ms?: RuntimeNumericValue;
  memory_mb?: RuntimeNumericValue;
}

export interface McpBindingIRLocal {
  server: string;
  tool: string;
  /** Per-call headers (may contain {{secrets.X}}, {{env.X}} templates) */
  headers?: Record<string, string>;
  server_config?: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    encrypted_env?: string;
    connection_timeout_ms?: number;
    request_timeout_ms?: number;
    allowed_commands?: string[];
    encrypted_auth_config?: string;
    auth_type?: string;
    auth_profile_id?: string;
    env_profile_id?: string;
  };
}

export interface SearchAIBindingIRLocal {
  tenantId: string;
  indexId: string;
  kbName?: string;
  searchInstructions?: string;
}

export interface ToolCompactionConfigLocal {
  essential_fields?: string[];
  max_description_length?: number;
}

const CONFIG_TEMPLATE_ONLY_RE = /^\{\{config\.[A-Za-z_][A-Za-z0-9_]*\}\}$/;

export function parseOptionalRuntimeNumber(
  value: string | undefined,
  fieldName: string,
): RuntimeNumericValue | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (CONFIG_TEMPLATE_ONLY_RE.test(trimmed)) return trimmed as ConfigRuntimeNumericTemplate;

  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `${fieldName} must be a number or exact {{config.KEY}} placeholder, got '${value}'`,
    );
  }
  return parsed;
}

// ─── Return Type (mirrors @abl/compiler ToolReturnType) ──────────────────────

export interface ToolReturnTypeLocal {
  type: string;
  fields?: Record<string, ToolReturnTypeLocal>;
  items?: ToolReturnTypeLocal;
  optional?: boolean;
}

/**
 * Parse a return type string from a DSL signature into structured ToolReturnTypeLocal.
 *
 * Handles:
 * - Simple types: "string", "number", "object"
 * - Array types: "string[]"
 * - Object types: "{name: string, email: string}"
 * - Optional fields: "{name: string, age?: number}"
 */
export function parseReturnTypeString(returnStr: string): ToolReturnTypeLocal {
  const trimmed = returnStr.trim();

  // Simple type: "string", "number", "object"
  if (/^\w+$/.test(trimmed)) return { type: trimmed };

  // Array type: "string[]"
  if (trimmed.endsWith('[]')) {
    return { type: 'array', items: parseReturnTypeString(trimmed.slice(0, -2)) };
  }

  // Object type: "{field: type, ...}"
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const fields: Record<string, ToolReturnTypeLocal> = {};
    const inner = trimmed.slice(1, -1);
    for (const part of inner.split(',')) {
      const match = part.trim().match(/^(\w+)(\?)?\s*:\s*(.+)$/);
      if (match) {
        const [, name, opt, typeStr] = match;
        fields[name] = { ...parseReturnTypeString(typeStr), ...(opt ? { optional: true } : {}) };
      }
    }
    return { type: 'object', fields };
  }

  // Fallback: treat as raw type string
  return { type: trimmed };
}

// ─── Parsed Signature ────────────────────────────────────────────────────────

export interface ParsedSignature {
  parameters: Array<{ name: string; type: string; required: boolean }>;
  returnType: string;
}

/**
 * Parse the signature line of a tool DSL content string.
 *
 * Format: `name(param1: type1, param2?: type2) -> {txnId: string}`
 *
 * Return type regex uses `.+` (not `\w+`) to capture complex types like
 * `{txnId: string}`, `string[]`, or `object`.
 */
export function parseSignatureLine(dslContent: string): ParsedSignature {
  const firstLine = dslContent.split('\n')[0]?.trim() ?? '';

  // Extract parameters: everything between first ( and matching )
  const paramsMatch = firstLine.match(/\(([^)]*)\)/);
  const parameters: ParsedSignature['parameters'] = [];
  if (paramsMatch?.[1]) {
    for (const part of paramsMatch[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\w+)(\?)?\s*:\s*(.+)$/);
      if (m) {
        parameters.push({ name: m[1], type: m[3].trim(), required: !m[2] });
      }
    }
  }

  // Extract return type: everything after ->
  // Handles complex types like {txnId: string}, string[], object
  const returnMatch = firstLine.match(/->\s*(.+)$/);
  const returnType = returnMatch ? returnMatch[1].trim() : 'object';

  return { parameters, returnType };
}

// ─── DSL Property Parser ─────────────────────────────────────────────────────

/**
 * Parse indented key:value properties from DSL content (skipping the signature line).
 */
export function parseDslProperties(dslContent: string): Record<string, string> {
  const props: Record<string, string> = {};
  const lines = dslContent.split('\n');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - trimmed.length;
    if (indent > 2) continue;

    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      props[key] = value.replace(/^["']|["']$/g, '').trim();
    }
  }

  return props;
}

function parseDslStringList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function parseDslToolCompaction(dslContent: string): ToolCompactionConfigLocal | undefined {
  const entries = parseDslNestedBlock(dslContent, 'compaction');
  if (entries.length === 0) return undefined;

  const compaction: ToolCompactionConfigLocal = {};
  for (const { key, value } of entries) {
    switch (key) {
      case 'essential_fields':
        compaction.essential_fields = parseDslStringList(value);
        break;
      case 'max_description_length': {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          throw new Error(`compaction.max_description_length must be a number, got '${value}'`);
        }
        compaction.max_description_length = parsed;
        break;
      }
    }
  }

  return Object.values(compaction).some((value) => value !== undefined) ? compaction : undefined;
}

// ─── Pipe Block Extractor ────────────────────────────────────────────────────

/**
 * Extract a pipe-syntax block (key: |) from DSL content.
 * Returns the concatenated indented lines after the pipe marker.
 */
export function extractPipeBlock(dslContent: string, key: string): string | null {
  const lines = dslContent.split('\n');
  let capturing = false;
  let baseIndent = 0;
  const codeLines: string[] = [];

  for (const line of lines) {
    if (capturing) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === '' || indent > baseIndent) {
        // Strip the base indentation
        codeLines.push(indent > baseIndent ? line.slice(baseIndent + 2) : '');
      } else {
        break; // Back to parent indentation — end of block
      }
    } else {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(`${key}:`) && trimmed.endsWith('|')) {
        capturing = true;
        baseIndent = line.length - line.trimStart().length;
      }
    }
  }

  return codeLines.length > 0 ? codeLines.join('\n').trimEnd() : null;
}

// ─── Rich Parameter Metadata Parsers ─────────────────────────────────────────

export interface ParamMetadata {
  description?: string;
  enum?: string[];
  default?: string;
  /** JSON string for nested object properties or array item schema */
  schema?: string;
}

/**
 * Parse the `params:` nested block from DSL content.
 * Returns a map of parameter name → metadata (description, enum, default).
 *
 * Expected format:
 * ```
 *   params:
 *     city:
 *       description: "City name or zip code"
 *       enum: metric, imperial
 *       default: metric
 * ```
 */
export function parseDslParamMetadata(dslContent: string): Map<string, ParamMetadata> {
  const result = new Map<string, ParamMetadata>();
  const lines = dslContent.split('\n');
  let inParams = false;
  let paramsIndent = -1;
  let currentParam: string | null = null;
  let paramIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (inParams) {
      // End of params block: non-empty line at same or lower indent as params:
      if (trimmed && indent <= paramsIndent) {
        break;
      }
      if (!trimmed) continue;

      // Check if this is a parameter name line (e.g. "    city:")
      if (currentParam !== null && indent > paramIndent) {
        // This is a sub-key of the current parameter
        const match = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
        if (match) {
          const [, key, rawValue] = match;
          const value = unquoteDslScalar(rawValue);
          const meta = result.get(currentParam) || {};
          switch (key) {
            case 'description':
              meta.description = value;
              break;
            case 'enum':
              meta.enum = value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              break;
            case 'default':
              meta.default = value;
              break;
            case 'schema':
              meta.schema = value;
              break;
          }
          result.set(currentParam, meta);
        }
      } else {
        // Check for a parameter name line: "    paramName:"
        const nameMatch = trimmed.match(/^(\w+)\s*:\s*$/);
        if (nameMatch) {
          currentParam = nameMatch[1];
          paramIndent = indent;
          result.set(currentParam, {});
        }
      }
    } else {
      // Look for "  params:" line
      if (trimmed === 'params:') {
        inParams = true;
        paramsIndent = indent;
      }
    }
  }

  return result;
}

function unquoteDslScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
  }
  return trimmed;
}

// ─── Binding Builders ────────────────────────────────────────────────────────

/**
 * Build an HTTP binding IR from parsed DSL properties.
 */
export function buildHttpBindingFromProps(
  props: Record<string, string>,
  dslContent?: string,
): HttpBindingIRLocal {
  const authType = (props.auth || 'none') as ToolAuthTypeIR;
  const binding: HttpBindingIRLocal = {
    endpoint: props.endpoint || '',
    method: (props.method || 'GET') as HttpBindingIRLocal['method'],
    auth: { type: authType },
  };

  // Auth config — parse from flat props and auth_config nested block
  if (authType !== 'none' || props.scopes) {
    const config: Record<string, unknown> = {};
    const authConfigInput: HttpAuthConfigInput = {
      tokenUrl: props.token_url,
      clientId: props.client_id,
      scopes: props.scopes,
      headerName: props.header_name,
      provider: props.provider,
    };

    // Parse auth_config nested block values (token, api_key, client_secret, etc.)
    if (dslContent) {
      const authEntries = parseDslNestedBlock(dslContent, 'auth_config');
      const authMap = Object.fromEntries(authEntries.map((e) => [e.key, e.value]));

      authConfigInput.token = authMap.token;
      authConfigInput.apiKey = authMap.api_key;
      authConfigInput.clientSecret = authMap.client_secret;
      authConfigInput.tokenUrl = authMap.token_url || props.token_url;
      authConfigInput.clientId = authMap.client_id || props.client_id;
      authConfigInput.scopes = authMap.scopes || props.scopes;
      authConfigInput.headerName = authMap.header_name || props.header_name;
      authConfigInput.provider = authMap.provider || props.provider;

      // Parse custom_headers deep nested block (only relevant for custom auth)
      if (authType === 'custom') {
        const customHeaderEntries = parseDslDeepNestedBlock(
          dslContent,
          'auth_config',
          'custom_headers',
        );
        if (customHeaderEntries.length > 0) {
          authConfigInput.customHeaders = Object.fromEntries(
            customHeaderEntries.map((e) => [e.key, e.value]),
          );
        }
      }
    }

    const normalizedAuthConfig = normalizeHttpAuthConfig(authType, authConfigInput, {
      authProfileRef: props.auth_profile,
    });

    if (normalizedAuthConfig?.token) config.token = normalizedAuthConfig.token;
    if (normalizedAuthConfig?.apiKey) config.apiKey = normalizedAuthConfig.apiKey;
    if (normalizedAuthConfig?.clientSecret) config.clientSecret = normalizedAuthConfig.clientSecret;
    if (normalizedAuthConfig?.customHeaders) {
      config.customHeaders = normalizedAuthConfig.customHeaders;
    }

    if (authType === 'oauth2_client') {
      config.oauth = {
        tokenUrl: normalizedAuthConfig?.tokenUrl || '',
        clientId: normalizedAuthConfig?.clientId || '',
        scopes: normalizedAuthConfig?.scopes
          ? normalizedAuthConfig.scopes.split(/[\s,]+/).filter(Boolean)
          : [],
      };
    } else if (props.scopes && !config.oauth) {
      config.oauth = {
        scopes: props.scopes.split(/[\s,]+/).filter(Boolean),
      };
    } else if (authType === 'oauth2_user') {
      config.provider = normalizedAuthConfig?.provider || '';
    } else if (authType === 'api_key') {
      config.headerName = normalizedAuthConfig?.headerName || 'X-API-Key';
    } else if (authType === 'bearer') {
      config.headerName = 'Authorization';
      config.headerPrefix = 'Bearer';
    }
    if (Object.keys(config).length > 0) {
      binding.auth.config = config;
    }
  }

  const timeoutMs = parseOptionalRuntimeNumber(props.timeout, 'HTTP binding timeout');
  if (timeoutMs !== undefined) binding.timeout_ms = timeoutMs;
  if (props.body_type) {
    binding.body_type = props.body_type as HttpBindingIRLocal['body_type'];
  }
  if (props.protocol) {
    binding.protocol = props.protocol as HttpBindingIRLocal['protocol'];
  }
  if (props.soap_version) {
    binding.soap_version = props.soap_version as HttpBindingIRLocal['soap_version'];
  }
  if (props.soap_action) {
    binding.soap_action = props.soap_action;
  }
  if (props.on_soap_fault) {
    binding.on_soap_fault = props.on_soap_fault as HttpBindingIRLocal['on_soap_fault'];
  }
  if (props.on_http_error) {
    binding.on_http_error = props.on_http_error as HttpBindingIRLocal['on_http_error'];
  }
  if (props.retry) {
    binding.retry = {
      count: parseOptionalRuntimeNumber(props.retry, 'HTTP binding retry') ?? 0,
      delay_ms:
        parseOptionalRuntimeNumber(props.retry_delay || '1000', 'HTTP binding retry_delay') ?? 1000,
    };
  }
  const rateLimit = parseOptionalRuntimeNumber(props.rate_limit, 'HTTP binding rate_limit');
  if (rateLimit !== undefined) binding.rate_limit_per_minute = rateLimit;

  if (dslContent) {
    const headerEntries = parseDslNestedBlock(dslContent, 'headers');
    if (headerEntries.length > 0) {
      binding.headers = {};
      for (const { key, value } of headerEntries) {
        binding.headers[key] = value;
      }
    }

    const cbEntries = parseDslNestedBlock(dslContent, 'circuit_breaker');
    if (cbEntries.length > 0) {
      const cbMap = Object.fromEntries(cbEntries.map((e) => [e.key, e.value]));
      if (cbMap.threshold && cbMap.reset_ms) {
        binding.circuit_breaker = {
          threshold:
            parseOptionalRuntimeNumber(cbMap.threshold, 'HTTP circuit_breaker threshold') ?? 0,
          reset_ms:
            parseOptionalRuntimeNumber(cbMap.reset_ms, 'HTTP circuit_breaker reset_ms') ?? 0,
        };
      }
    }

    const qpEntries = parseDslNestedBlock(dslContent, 'query_params');
    if (qpEntries.length > 0) {
      binding.query_params = {};
      for (const { key, value } of qpEntries) {
        binding.query_params[key] = value;
      }
    }

    const bodyTemplate =
      extractPipeBlock(dslContent, 'body_template') || extractPipeBlock(dslContent, 'body');
    if (bodyTemplate) {
      binding.body_template = bodyTemplate;
    }
  }

  return binding;
}

/**
 * Build a sandbox binding IR from parsed DSL properties and raw content.
 */
export function buildSandboxBindingFromProps(
  props: Record<string, string>,
  dslContent: string,
): SandboxBindingIRLocal {
  const codeContent = extractPipeBlock(dslContent, 'code');

  return {
    runtime: (props.runtime || 'javascript') as 'javascript' | 'python',
    code_content: codeContent || '',
    timeout_ms: parseOptionalRuntimeNumber(props.timeout, 'Sandbox binding timeout'),
    memory_mb: parseOptionalRuntimeNumber(props.memory_mb, 'Sandbox binding memory_mb'),
  };
}

/**
 * Build an MCP binding IR from parsed DSL properties.
 *
 * @param props - Parsed DSL properties
 * @param toolName - Tool name (used as fallback for server_tool)
 * @param options - Optional: dslContent for header parsing, mcpConfigMap for server config baking
 */
export function buildMcpBindingFromProps(
  props: Record<string, string>,
  toolName: string,
  options?: {
    mcpConfigMap?: Map<string, McpServerConfigForIR>;
    dslContent?: string;
  },
): McpBindingIRLocal {
  const { mcpConfigMap, dslContent } = options ?? {};
  const serverName = props.server || '';
  const binding: McpBindingIRLocal = {
    server: serverName,
    tool: props.server_tool || props.tool || toolName,
  };

  // Parse headers nested block from DSL
  if (dslContent) {
    const headerEntries = parseDslNestedBlock(dslContent, 'headers');
    if (headerEntries.length > 0) {
      binding.headers = {};
      for (const { key, value } of headerEntries) {
        binding.headers[key] = value;
      }
    }
  }

  // Bake full MCP server config inline (zero DB lookups at runtime)
  if (mcpConfigMap) {
    const serverConfig = mcpConfigMap.get(serverName);
    if (serverConfig) {
      // Merge server-level headers with per-tool headers (per-tool takes precedence)
      if (serverConfig.headers) {
        try {
          const serverHeaders =
            typeof serverConfig.headers === 'string'
              ? (JSON.parse(serverConfig.headers) as Record<string, string>)
              : undefined;
          if (serverHeaders && typeof serverHeaders === 'object') {
            binding.headers = { ...serverHeaders, ...binding.headers };
          }
        } catch {
          // Invalid JSON in server headers — skip silently (headers field is optional)
        }
      }

      binding.server_config = {
        name: serverConfig.name,
        transport: serverConfig.transport as 'stdio' | 'sse' | 'http',
        url: serverConfig.url ?? undefined,
        encrypted_env: serverConfig.encryptedEnv ?? undefined,
        connection_timeout_ms: serverConfig.connectionTimeoutMs ?? undefined,
        request_timeout_ms: serverConfig.requestTimeoutMs ?? undefined,
        encrypted_auth_config: serverConfig.encryptedAuthConfig ?? undefined,
        auth_type: serverConfig.authType ?? 'none',
        auth_profile_id: serverConfig.authProfileId ?? undefined,
        env_profile_id: serverConfig.envProfileId ?? undefined,
      };
    }
  }

  return binding;
}

/**
 * Build a SearchAI KB binding from DSL properties.
 *
 * DSL example:
 * ```
 * search_products(query: string, queryType?: string, filters?: object[]) -> SearchResult
 *   type: searchai
 *   index_id: "idx_products_v2"
 *   tenant_id: "tenant_123"
 *   kb_name: "Product Documentation"
 * ```
 */
export function buildSearchAIBindingFromProps(
  props: Record<string, string>,
): SearchAIBindingIRLocal {
  const rawInstructions = props.search_instructions;
  return {
    tenantId: props.tenant_id || '',
    indexId: props.index_id || '',
    kbName: props.kb_name || undefined,
    searchInstructions: rawInstructions && rawInstructions !== '|' ? rawInstructions : undefined,
  };
}

// ─── Workflow Binding ────────────────────────────────────────────────────────

export interface WorkflowBindingLocal {
  workflowId: string;
  workflowVersionId?: string;
  /** Semver pin for the workflow version (e.g. 'v0.2.0' or 'draft'). When absent, auto-resolve picks the latest active version. */
  workflowVersion?: string;
  triggerId: string;
  mode: 'sync' | 'async';
  timeoutMs?: RuntimeNumericValue;
  paramMapping?: Record<string, string>;
}

/**
 * Build a Workflow binding from DSL properties.
 *
 * DSL example:
 * ```
 * run_approval(payload: object) -> object
 *   type: workflow
 *   workflow_id: "wf_abc123"
 *   trigger_id: "tr_xyz789"
 *   mode: sync
 *   timeout_ms: 30000
 *   param_mapping: {"order_id": "$.payload.orderId"}
 * ```
 */
export function buildWorkflowBindingFromProps(props: Record<string, string>): WorkflowBindingLocal {
  const workflowId = props.workflow_id;
  if (!workflowId) {
    throw new Error('Workflow binding requires workflow_id property');
  }

  const workflowVersionId = props.workflow_version_id || undefined;

  const triggerId = props.trigger_id;
  if (!triggerId) {
    throw new Error('Workflow binding requires trigger_id property');
  }

  const modeRaw = props.mode || 'sync';
  if (modeRaw !== 'sync' && modeRaw !== 'async') {
    throw new Error(`Workflow binding mode must be 'sync' or 'async', got '${modeRaw}'`);
  }

  let timeoutMs: RuntimeNumericValue | undefined;
  if (props.timeout_ms) {
    timeoutMs = parseOptionalRuntimeNumber(props.timeout_ms, 'Workflow binding timeout_ms');
  }

  let paramMapping: Record<string, string> | undefined;
  if (props.param_mapping) {
    try {
      const parsed: unknown = JSON.parse(props.param_mapping);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('param_mapping must be a JSON object');
      }
      paramMapping = parsed as Record<string, string>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid param_mapping JSON in workflow binding: ${message}`);
    }
  }

  const workflowVersion =
    props.workflow_version && props.workflow_version.trim() !== ''
      ? props.workflow_version.trim()
      : undefined;

  return {
    workflowId,
    ...(workflowVersionId ? { workflowVersionId } : {}),
    ...(workflowVersion !== undefined ? { workflowVersion } : {}),
    triggerId,
    mode: modeRaw,
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(paramMapping !== undefined && { paramMapping }),
  };
}
