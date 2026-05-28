/**
 * Parse DSL to Tool Form
 *
 * Reverse of serialize-tool-form-to-dsl.ts — converts a tool DSL content
 * string back into a typed ProjectToolFormData discriminated union,
 * suitable for populating Studio edit wizard forms.
 *
 * Reuses shared parsing utilities from dsl-property-parser.ts:
 * - parseSignatureLine() — params + returnType
 * - parseDslProperties() — flat key-value props
 * - extractPipeBlock() — sandbox code block
 */

import type {
  ProjectToolFormData,
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
  SearchAIToolFormData,
  WorkflowToolFormData,
  HttpAuthType,
  HttpAuthConfig,
  RuntimeNumericValue,
} from '../types/project-tool-form.js';
import {
  parseSignatureLine,
  parseDslProperties,
  extractPipeBlock,
  parseDslParamMetadata,
  parseOptionalRuntimeNumber,
} from './dsl-property-parser.js';
import { normalizeHttpAuthConfig } from './http-auth-config-normalizer.js';

// ─── Nested Block Parser ──────────────────────────────────────────────────────

/**
 * Parse a nested block from DSL content.
 *
 * Given a block key like "auth_config", finds lines like:
 *   auth_config:
 *     token_url: https://...
 *     client_id: my-client
 *
 * and returns [{ key: 'token_url', value: 'https://...' }, ...].
 *
 * Supports mixed-case keys (e.g., Content-Type, Authorization) unlike
 * parseDslProperties() which only matches [a-z_]+.
 */
export function parseDslNestedBlock(
  dslContent: string,
  blockKey: string,
): Array<{ key: string; value: string }> {
  const lines = dslContent.split('\n');
  const entries: Array<{ key: string; value: string }> = [];
  let capturing = false;
  let blockIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (capturing) {
      // End of block: line at same or lower indent (and non-empty)
      if (trimmed && indent <= blockIndent) {
        break;
      }
      // Skip empty lines
      if (!trimmed) continue;

      // Match key: value — supports mixed-case keys like Content-Type
      // Also supports {{env.X}} / {{secrets.X}} template placeholders as keys
      const match = trimmed.match(/^(\{\{[\w.]+\}\}|[\w.:-]+)\s*:\s*(.*)$/);
      if (match) {
        const [, key, rawValue] = match;
        // Check if this is a sub-block (value is empty = nested block)
        if (!rawValue.trim()) {
          // This is a deeper nested block — skip for now
          continue;
        }
        entries.push({ key, value: rawValue.replace(/^["']|["']$/g, '').trim() });
      }
    } else {
      // Look for the block key line: "  blockKey:" with empty value
      const blockMatch = trimmed.match(new RegExp(`^${escapeRegex(blockKey)}\\s*:\\s*$`));
      if (blockMatch) {
        capturing = true;
        blockIndent = indent;
      }
    }
  }

  return entries;
}

/**
 * Parse a deeply nested block (e.g., custom_headers inside auth_config).
 * Returns entries at the third indentation level under the parent block.
 */
export function parseDslDeepNestedBlock(
  dslContent: string,
  parentBlockKey: string,
  childBlockKey: string,
): Array<{ key: string; value: string }> {
  const lines = dslContent.split('\n');
  const entries: Array<{ key: string; value: string }> = [];
  let inParent = false;
  let inChild = false;
  let parentIndent = -1;
  let childIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (inChild) {
      if (trimmed && indent <= childIndent) {
        break;
      }
      if (!trimmed) continue;
      const match = trimmed.match(/^([\w.:-]+)\s*:\s*(.*)$/);
      if (match) {
        const [, key, rawValue] = match;
        if (rawValue.trim()) {
          entries.push({ key, value: rawValue.replace(/^["']|["']$/g, '').trim() });
        }
      }
    } else if (inParent) {
      if (trimmed && indent <= parentIndent) {
        break;
      }
      const childMatch = trimmed.match(new RegExp(`^${escapeRegex(childBlockKey)}\\s*:\\s*$`));
      if (childMatch) {
        inChild = true;
        childIndent = indent;
      }
    } else {
      const parentMatch = trimmed.match(new RegExp(`^${escapeRegex(parentBlockKey)}\\s*:\\s*$`));
      if (parentMatch) {
        inParent = true;
        parentIndent = indent;
      }
    }
  }

  return entries;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Unquote Helper ───────────────────────────────────────────────────────────

/** Remove surrounding quotes from a value if present */
function unquote(value: string): string {
  if (!value) return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    /* v8 ignore start */
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    /* v8 ignore stop */
  }
  return trimmed;
}

// ─── Main Parser ──────────────────────────────────────────────────────────────

/**
 * Parse a tool DSL content string into a ProjectToolFormData discriminated union.
 *
 * @param dslContent - The raw DSL string (from project_tools.dslContent)
 * @param toolType - The tool type ('http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow')
 * @returns The parsed form data, or null if parsing fails
 */
export function parseDslToToolForm(
  dslContent: string,
  toolType: 'http' | 'sandbox' | 'mcp' | 'searchai' | 'workflow',
): ProjectToolFormData | null {
  if (!dslContent?.trim()) return null;

  try {
    // ── Common fields ───────────────────────────────────────────────
    const { parameters, returnType } = parseSignatureLine(dslContent);
    const props = parseDslProperties(dslContent);

    // Extract name from the signature line
    const firstLine = dslContent.split('\n')[0]?.trim() ?? '';
    const nameMatch = firstLine.match(/^(\w+)\s*\(/);
    const name = nameMatch ? nameMatch[1] : '';

    if (!name) return null;

    const description = props.description ? unquote(props.description) : null;

    // ── Merge rich parameter metadata from params: block ─────────────
    const paramMeta = parseDslParamMetadata(dslContent);
    const formParams = parameters.map((p) => {
      const meta = paramMeta.get(p.name);
      return {
        name: p.name,
        type: p.type,
        required: p.required,
        description: meta?.description || '',
        ...(meta?.enum && { enumValues: meta.enum }),
        ...(meta?.default !== undefined && { defaultValue: meta.default }),
        ...(meta?.schema && { objectSchema: meta.schema }),
      };
    });

    // ── Type-specific parsing ───────────────────────────────────────
    switch (toolType) {
      case 'http':
        return parseHttpForm(name, description, formParams, returnType, props, dslContent);
      case 'sandbox':
        return parseSandboxForm(name, description, formParams, returnType, props, dslContent);
      case 'mcp':
        return parseMcpForm(name, description, formParams, returnType, props, dslContent);
      case 'searchai':
        return parseSearchAIForm(name, description, formParams, returnType, props);
      case 'workflow':
        return parseWorkflowForm(name, description, formParams, returnType, props);
      default:
        return null;
    }
  } catch {
    /* v8 ignore start */
    return null;
    /* v8 ignore stop */
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function parseHttpForm(
  name: string,
  description: string | null,
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    enumValues?: string[];
    defaultValue?: string;
  }>,
  returnType: string,
  props: Record<string, string>,
  dslContent: string,
): HttpToolFormData {
  const auth = (props.auth || 'none') as HttpAuthType;
  const authProfileRef = props.auth_profile ? unquote(props.auth_profile) : undefined;
  const topLevelScopes = props.scopes ? unquote(props.scopes) : undefined;

  // Parse auth_config nested block
  let authConfig: HttpAuthConfig | undefined;
  if (auth !== 'none' || topLevelScopes) {
    const authEntries = parseDslNestedBlock(dslContent, 'auth_config');
    const ac: HttpAuthConfig = {};
    for (const { key, value } of authEntries) {
      switch (key) {
        case 'token':
          ac.token = unquote(value);
          break;
        case 'api_key':
          ac.apiKey = unquote(value);
          break;
        case 'token_url':
          ac.tokenUrl = unquote(value);
          break;
        case 'client_id':
          ac.clientId = unquote(value);
          break;
        case 'client_secret':
          ac.clientSecret = unquote(value);
          break;
        case 'scopes':
          ac.scopes = unquote(value);
          break;
        case 'header_name':
          ac.headerName = unquote(value);
          break;
        case 'provider':
          ac.provider = unquote(value);
          break;
      }
    }

    if (topLevelScopes) {
      ac.scopes = topLevelScopes;
    }

    // Parse custom_headers deep nested block
    const customHeaderEntries = parseDslDeepNestedBlock(
      dslContent,
      'auth_config',
      'custom_headers',
    );
    if (customHeaderEntries.length > 0) {
      ac.customHeaders = {};
      for (const { key, value } of customHeaderEntries) {
        ac.customHeaders[key] = unquote(value);
      }
    }

    authConfig = normalizeHttpAuthConfig(auth, ac, { authProfileRef });
  }

  // Parse headers nested block
  const headerEntries = parseDslNestedBlock(dslContent, 'headers');
  const headers =
    headerEntries.length > 0
      ? headerEntries.map((e) => ({ key: e.key, value: unquote(e.value) }))
      : undefined;

  // Parse query_params nested block
  const qpEntries = parseDslNestedBlock(dslContent, 'query_params');
  const queryParams =
    qpEntries.length > 0
      ? qpEntries.map((e) => ({ key: e.key, value: unquote(e.value) }))
      : undefined;

  // Parse body-related fields
  const body = extractPipeBlock(dslContent, 'body');
  const bodySchema = extractPipeBlock(dslContent, 'body_schema');

  // Parse circuit_breaker nested block
  const cbEntries = parseDslNestedBlock(dslContent, 'circuit_breaker');
  let circuitBreaker: { threshold: RuntimeNumericValue; resetMs: RuntimeNumericValue } | undefined;
  if (cbEntries.length > 0) {
    const cbMap: Record<string, string> = {};
    for (const { key, value } of cbEntries) {
      cbMap[key] = value;
    }
    if (cbMap.threshold && cbMap.reset_ms) {
      circuitBreaker = {
        threshold: parseOptionalRuntimeNumber(cbMap.threshold, 'circuit_breaker.threshold') ?? 0,
        resetMs: parseOptionalRuntimeNumber(cbMap.reset_ms, 'circuit_breaker.reset_ms') ?? 0,
      };
    }
  }

  const form: HttpToolFormData = {
    name,
    toolType: 'http',
    description: description || '',
    parameters,
    returnType,
    endpoint: unquote(props.endpoint || ''),
    method: (props.method || 'GET') as HttpToolFormData['method'],
    auth,
  };

  if (authConfig) form.authConfig = authConfig;
  if (authProfileRef) form.authProfileRef = authProfileRef;
  if (props.auth_jit === 'true') form.authJit = true;
  if (props.consent) {
    form.consentMode = props.consent as NonNullable<HttpToolFormData['consentMode']>;
  }
  if (props.connection) {
    form.connectionMode = props.connection as NonNullable<HttpToolFormData['connectionMode']>;
  }
  if (headers) form.headers = headers;
  if (queryParams) form.queryParams = queryParams;
  if (body) form.body = body;
  if (props.body_type) form.bodyType = props.body_type as HttpToolFormData['bodyType'];
  if (bodySchema) form.bodySchema = bodySchema;
  if (props.use_body_schema === 'true') form.useBodySchema = true;
  if (props.timeout) form.timeout = parseOptionalRuntimeNumber(props.timeout, 'timeout');
  if (props.retry) form.retry = parseOptionalRuntimeNumber(props.retry, 'retry');
  if (props.retry_delay) {
    form.retryDelay = parseOptionalRuntimeNumber(props.retry_delay, 'retry_delay');
  }
  if (props.rate_limit) form.rateLimit = parseOptionalRuntimeNumber(props.rate_limit, 'rate_limit');
  if (circuitBreaker) form.circuitBreaker = circuitBreaker;
  if (props.protocol) {
    form.protocol = props.protocol as HttpToolFormData['protocol'];
  }
  if (props.soap_version) {
    form.soapVersion = props.soap_version as HttpToolFormData['soapVersion'];
  }
  if (props.soap_action) {
    form.soapAction = unquote(props.soap_action);
  }
  if (props.on_soap_fault) {
    form.onSoapFault = props.on_soap_fault as HttpToolFormData['onSoapFault'];
  }
  if (props.on_http_error) {
    form.onHttpError = props.on_http_error as HttpToolFormData['onHttpError'];
  }

  return form;
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────

function parseSandboxForm(
  name: string,
  description: string | null,
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    enumValues?: string[];
    defaultValue?: string;
  }>,
  returnType: string,
  props: Record<string, string>,
  dslContent: string,
): SandboxToolFormData {
  const code = extractPipeBlock(dslContent, 'code') || '';

  const form: SandboxToolFormData = {
    name,
    toolType: 'sandbox',
    description: description || '',
    parameters,
    returnType,
    runtime: (props.runtime || 'javascript') as SandboxToolFormData['runtime'],
    code,
  };

  if (props.memory_mb) {
    form.memoryMb = parseOptionalRuntimeNumber(props.memory_mb, 'memory_mb');
  }
  if (props.timeout) form.timeout = parseOptionalRuntimeNumber(props.timeout, 'timeout');

  return form;
}

// ─── MCP ──────────────────────────────────────────────────────────────────────

function parseMcpForm(
  name: string,
  description: string | null,
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    enumValues?: string[];
    defaultValue?: string;
  }>,
  returnType: string,
  props: Record<string, string>,
  dslContent: string,
): McpToolFormData {
  const form: McpToolFormData = {
    name,
    toolType: 'mcp',
    description: description || '',
    parameters,
    returnType,
    server: unquote(props.server || props.server_url || ''),
  };

  if (props.server_tool || props.tool) form.serverTool = unquote(props.server_tool || props.tool);
  if (props.transport_type) form.transportType = unquote(props.transport_type);

  // Parse headers nested block
  const headerEntries = parseDslNestedBlock(dslContent, 'headers');
  if (headerEntries.length > 0) {
    form.headers = headerEntries.map((e) => ({ key: e.key, value: unquote(e.value) }));
  }

  return form;
}

// ─── SearchAI ──────────────────────────────────────────────────────────────────

function parseSearchAIForm(
  name: string,
  description: string | null,
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    enumValues?: string[];
    defaultValue?: string;
  }>,
  returnType: string,
  props: Record<string, string>,
): SearchAIToolFormData {
  const form: SearchAIToolFormData = {
    name,
    toolType: 'searchai',
    description: description || '',
    parameters,
    returnType,
    indexId: unquote(props.index_id || ''),
    tenantId: unquote(props.tenant_id || ''),
  };

  if (props.kb_name) {
    form.kbName = unquote(props.kb_name);
  }

  return form;
}

// ─── Workflow ────────────────────────────────────────────────────────────────

function parseWorkflowForm(
  name: string,
  description: string | null,
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    enumValues?: string[];
    defaultValue?: string;
  }>,
  returnType: string,
  props: Record<string, string>,
): WorkflowToolFormData {
  const form: WorkflowToolFormData = {
    name,
    toolType: 'workflow',
    description: description || '',
    parameters,
    returnType,
    workflowId: unquote(props.workflow_id || ''),
    triggerId: unquote(props.trigger_id || ''),
    mode: props.mode === 'async' ? 'async' : 'sync',
  };

  if (props.workflow_version_id) {
    form.workflowVersionId = unquote(props.workflow_version_id);
  }
  if (props.workflow_version) {
    form.workflowVersion = unquote(props.workflow_version);
  }
  if (props.timeout_ms) {
    form.timeoutMs = parseOptionalRuntimeNumber(props.timeout_ms, 'timeout_ms');
  }
  if (props.param_mapping) {
    try {
      const parsed: unknown = JSON.parse(unquote(props.param_mapping));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        form.paramMapping = parsed as Record<string, string>;
      }
    } catch {
      // Ignore invalid mapping here; persistence validation reports the hard error.
    }
  }

  return form;
}
