/**
 * Project Tool Validator
 *
 * 5-phase validation pipeline for project_tools dslContent. All errors are
 * collected (not thrown) and returned as structured ValidationDiagnostic[].
 *
 * Phases:
 *   1. Parse — Parse DSL string to tool AST via @abl/core parser
 *   2. Structural — Name format, required `type` field
 *   3. Type-Specific — Per-type field validation (endpoint, method, auth, code, server, etc.)
 *   4. Security — Plaintext secret detection in auth-related fields
 *   5. Trial Compile — Compile to IR binding (catch malformed configs)
 *
 * Follows existing predicate validator pattern: pure functions, no classes,
 * no thrown exceptions.
 */

import { validateUrlForSSRF, getDevSSRFOptions } from '../security/index.js';
import { MAX_CODE_SIZE, MAX_DESCRIPTION_LENGTH } from '../validation/tool-validation.js';
import {
  buildHttpBindingFromProps,
  buildSandboxBindingFromProps,
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  parseOptionalRuntimeNumber,
  type RuntimeNumericValue,
} from './dsl-property-parser.js';

// ─── Types ───────────────────────────────────────────────────────────────

export type DiagnosticSeverity = 'error' | 'warning';

export interface ValidationDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  field?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
}

export interface ValidateToolDslContext {
  tenantId: string;
  projectId: string;
  existingNames?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────

const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;
const VALID_TOOL_TYPES = new Set(['http', 'sandbox', 'mcp', 'searchai', 'workflow']);
const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_AUTH_TYPES = new Set([
  'none',
  'api_key',
  'bearer',
  'oauth2_client',
  'oauth2_user',
  'custom',
]);
const VALID_RUNTIMES = new Set(['javascript', 'python']);

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;
const MIN_MEMORY_MB = 128;
const MAX_MEMORY_MB = 4096;
const MAX_DSL_SIZE = 512 * 1024;
const SANDBOX_CODE_WARNING_SIZE = 64 * 1024;
const URL_TEMPLATE_PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;

/** Patterns that suggest plaintext secrets in fields that should use {{secrets.X}} */
const PLAINTEXT_SECRET_PATTERNS = [
  /^sk[-_]/i, // OpenAI-style API keys
  /^pk[-_]/i, // Public keys (still shouldn't be inline)
  /^ghp_/i, // GitHub personal access tokens
  /^gho_/i, // GitHub OAuth tokens
  /^Bearer\s+[A-Za-z0-9\-._~+/]+=*/i, // Bearer token values
  /^Basic\s+[A-Za-z0-9+/]+=*/i, // Basic auth values
  /^eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/i, // JWT tokens
];

function validateRuntimeNumberRange(input: {
  value: string | undefined;
  fieldName: string;
  code: string;
  field: string;
  min: number;
  max: number;
  message: string;
  errors: ValidationDiagnostic[];
}): RuntimeNumericValue | undefined {
  if (!input.value) {
    return undefined;
  }

  let parsed: RuntimeNumericValue | undefined;
  try {
    parsed = parseOptionalRuntimeNumber(input.value, input.fieldName);
  } catch {
    input.errors.push({
      code: input.code,
      severity: 'error',
      message: input.message,
      field: input.field,
    });
    return undefined;
  }

  if (typeof parsed === 'number' && (parsed < input.min || parsed > input.max)) {
    input.errors.push({
      code: input.code,
      severity: 'error',
      message: input.message,
      field: input.field,
    });
  }

  return parsed;
}

function validateHttpEndpointForSsrf(endpoint: string) {
  const match = URL_TEMPLATE_PLACEHOLDER_RE.exec(endpoint);
  URL_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
  if (!match) {
    return validateUrlForSSRF(endpoint, getDevSSRFOptions());
  }

  const prefix = endpoint.slice(0, match.index);
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(prefix)) {
    return { safe: true };
  }

  const endpointForValidation = endpoint.replace(URL_TEMPLATE_PLACEHOLDER_RE, 'placeholder');
  URL_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
  return validateUrlForSSRF(endpointForValidation, getDevSSRFOptions());
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Validate a tool DSL content string through the 5-phase pipeline.
 *
 * @param dslContent - The raw DSL string to validate
 * @param context - Tenant/project context and optional existing tool names for duplicate check
 * @returns ValidationResult with collected errors and warnings
 */
export function validateToolDsl(
  dslContent: string,
  context: ValidateToolDslContext,
  traceEmitter?: (event: {
    type: string;
    data: Record<string, unknown>;
    durationMs?: number;
  }) => void,
): ValidationResult {
  const startTime = Date.now();
  const errors: ValidationDiagnostic[] = [];
  const warnings: ValidationDiagnostic[] = [];

  // Pre-check: size limit
  if (dslContent.length > MAX_DSL_SIZE) {
    errors.push({
      code: 'E730',
      severity: 'error',
      message: `DSL content exceeds maximum size of ${MAX_DSL_SIZE} bytes`,
      field: 'dslContent',
    });
    return { valid: false, errors, warnings };
  }

  // Phase 1: Parse — Extract structured data from DSL lines
  const parsed = parseDslContent(dslContent);
  if (!parsed) {
    errors.push({
      code: 'E730',
      severity: 'error',
      message: 'Failed to parse tool DSL: invalid syntax or missing signature line',
      field: 'dslContent',
    });
    return { valid: false, errors, warnings };
  }

  // Phase 2: Structural validation
  validateStructural(parsed, context, errors, warnings);

  // Phase 3: Type-specific validation
  if (parsed.type) {
    validateTypeSpecific(parsed, errors, warnings);
  }

  // Phase 4: Security checks
  validateSecurity(parsed, errors, warnings);

  // Phase 5: Trial compile — verify DSL compiles to a valid binding
  if (parsed.type) {
    validateTrialCompile(parsed, errors);
  }

  const isValid = errors.length === 0;
  const durationMs = Date.now() - startTime;

  if (isValid) {
    traceEmitter?.({
      type: 'tool.validation.pass',
      data: {
        toolName: parsed?.name ?? 'unknown',
        toolType: parsed?.type ?? 'unknown',
        phasesRun: 5,
      },
      durationMs,
    });
  } else {
    traceEmitter?.({
      type: 'tool.validation.fail',
      data: {
        toolName: parsed?.name ?? 'unknown',
        toolType: parsed?.type ?? 'unknown',
        failedPhase: errors[0]?.code ?? 'unknown',
        errorCount: errors.length,
      },
      durationMs,
    });
  }

  return {
    valid: isValid,
    errors,
    warnings,
  };
}

// ─── Phase 1: Parse ──────────────────────────────────────────────────────

interface ParsedToolDsl {
  name: string;
  parameters: Array<{ name: string; type: string; required: boolean }>;
  invalidParameterFragments: string[];
  returnType: string;
  description: string | null;
  type: string | null;
  properties: Record<string, string>;
  rawContent: string;
}

function parseDslContent(dslContent: string): ParsedToolDsl | null {
  const lines = dslContent.split('\n');
  if (lines.length === 0) return null;

  // Parse signature line: name(params) [-> returnType]
  const sigLine = lines[0].trim();
  const sigMatch = sigLine.match(/^([a-z][a-z0-9_]*)\s*\(([^)]*)\)(?:\s*->\s*(.+))?$/);
  if (!sigMatch) return null;

  const [, name, paramStr, returnType] = sigMatch;

  // Parse parameters
  const parameters: Array<{ name: string; type: string; required: boolean }> = [];
  const invalidParameterFragments: string[] = [];
  if (paramStr.trim()) {
    for (const part of paramStr.split(',')) {
      const trimmed = part.trim();
      const paramMatch = trimmed.match(/^(\w+)(\?)?\s*:\s*(.+)$/);
      if (paramMatch) {
        parameters.push({
          name: paramMatch[1],
          type: paramMatch[3].trim(),
          required: !paramMatch[2],
        });
      } else {
        invalidParameterFragments.push(trimmed);
      }
    }
  }

  // Parse indented properties — only extract top-level properties (2-space indent).
  // Nested block entries (4+ space indent, e.g. header values under `headers:`,
  // auth_config entries under `auth_config:`) must NOT be promoted to top-level
  // properties, as their keys can collide with real DSL keywords (e.g. a header
  // named "auth" would shadow the tool's `auth:` property).
  const properties: Record<string, string> = {};
  let description: string | null = null;
  let toolType: string | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    // Measure leading whitespace — top-level DSL properties use exactly 2 spaces
    const indent = line.length - line.trimStart().length;
    if (indent !== 2) continue;

    const trimmed = line.trimStart();
    const propMatch = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      const cleanValue = value.replace(/^["']|["']$/g, '').trim();
      properties[key] = cleanValue;

      if (key === 'description') description = cleanValue;
      if (key === 'type') toolType = cleanValue;
    }
  }

  return {
    name,
    parameters,
    invalidParameterFragments,
    returnType: returnType?.trim() || 'object',
    description,
    type: toolType,
    properties,
    rawContent: dslContent,
  };
}

// ─── Phase 2: Structural ────────────────────────────────────────────────

function validateStructural(
  parsed: ParsedToolDsl,
  context: ValidateToolDslContext,
  errors: ValidationDiagnostic[],
  warnings: ValidationDiagnostic[],
): void {
  // E731: Name format
  if (!TOOL_NAME_REGEX.test(parsed.name)) {
    errors.push({
      code: 'E731',
      severity: 'error',
      message: `Tool name "${parsed.name}" must match pattern: start with lowercase letter, contain only a-z, 0-9, underscore, min 2 chars`,
      field: 'name',
    });
  }

  if (parsed.invalidParameterFragments.length > 0) {
    errors.push({
      code: 'E731',
      severity: 'error',
      message: `Invalid parameter syntax: ${parsed.invalidParameterFragments.join(', ')}. Use name: type or name?: type.`,
      field: 'parameters',
    });
  }

  // Duplicate name check
  if (context.existingNames?.includes(parsed.name)) {
    errors.push({
      code: 'E731',
      severity: 'error',
      message: `Tool name "${parsed.name}" already exists in this project`,
      field: 'name',
    });
  }

  // E732: Missing type
  if (!parsed.type) {
    errors.push({
      code: 'E732',
      severity: 'error',
      message: 'Tool must declare a type (http, sandbox, or mcp)',
      field: 'type',
    });
  } else if (!VALID_TOOL_TYPES.has(parsed.type)) {
    errors.push({
      code: 'E732',
      severity: 'error',
      message: `Invalid tool type "${parsed.type}". Must be one of: http, sandbox, mcp, searchai, workflow`,
      field: 'type',
    });
  }

  // W730: Description warning
  if (!parsed.description) {
    warnings.push({
      code: 'W730',
      severity: 'warning',
      message: 'Tool has no description. LLMs rely on descriptions to select tools correctly.',
      field: 'description',
    });
  } else if (parsed.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({
      code: 'E731',
      severity: 'error',
      message: `Description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`,
      field: 'description',
    });
  }
}

// ─── Phase 3: Type-Specific ─────────────────────────────────────────────

function validateTypeSpecific(
  parsed: ParsedToolDsl,
  errors: ValidationDiagnostic[],
  warnings: ValidationDiagnostic[],
): void {
  switch (parsed.type) {
    case 'http':
      validateHttpTool(parsed, errors, warnings);
      break;
    case 'sandbox':
      validateSandboxTool(parsed, errors, warnings);
      break;
    case 'mcp':
      validateMcpTool(parsed, errors);
      break;
    case 'searchai':
      validateSearchAITool(parsed, errors);
      break;
    case 'workflow':
      validateWorkflowTool(parsed, errors);
      break;
  }
}

function validateWorkflowTool(parsed: ParsedToolDsl, errors: ValidationDiagnostic[]): void {
  const p = parsed.properties;

  if (!p.workflow_id) {
    errors.push({
      severity: 'error',
      code: 'WORKFLOW_MISSING_WORKFLOW_ID',
      field: 'workflow_id',
      message: 'Workflow tool requires workflow_id property',
    });
  }

  if (!p.trigger_id) {
    errors.push({
      severity: 'error',
      code: 'WORKFLOW_MISSING_TRIGGER_ID',
      field: 'trigger_id',
      message: 'Workflow tool requires trigger_id property',
    });
  }

  if (p.mode && p.mode !== 'sync' && p.mode !== 'async') {
    errors.push({
      severity: 'error',
      code: 'WORKFLOW_INVALID_MODE',
      field: 'mode',
      message: `Workflow mode must be 'sync' or 'async', got '${p.mode}'`,
    });
  }

  validateRuntimeNumberRange({
    value: p.timeout_ms,
    fieldName: 'Workflow binding timeout_ms',
    code: 'WORKFLOW_INVALID_TIMEOUT',
    field: 'timeout_ms',
    min: MIN_TIMEOUT_MS,
    max: MAX_TIMEOUT_MS,
    message: `Workflow timeout_ms must be between ${MIN_TIMEOUT_MS}ms and ${MAX_TIMEOUT_MS}ms`,
    errors,
  });
}

function validateSearchAITool(parsed: ParsedToolDsl, errors: ValidationDiagnostic[]): void {
  if (!parsed.properties.index_id) {
    errors.push({
      severity: 'error',
      code: 'SEARCHAI_MISSING_INDEX_ID',
      field: 'index_id',
      message: 'SearchAI tool requires index_id property',
    });
  }
  if (!parsed.properties.tenant_id) {
    errors.push({
      severity: 'error',
      code: 'SEARCHAI_MISSING_TENANT_ID',
      field: 'tenant_id',
      message: 'SearchAI tool requires tenant_id property',
    });
  }
}

function validateHttpTool(
  parsed: ParsedToolDsl,
  errors: ValidationDiagnostic[],
  warnings: ValidationDiagnostic[],
): void {
  const p = parsed.properties;

  // E733: Endpoint required
  if (!p.endpoint) {
    errors.push({
      code: 'E733',
      severity: 'error',
      message: 'HTTP tool requires an endpoint URL',
      field: 'endpoint',
    });
  } else {
    // E761: SSRF check. Runtime template placeholders are allowed, but any
    // literal absolute URL prefix still has to pass the same safety gate.
    const endpoint = p.endpoint;
    const ssrfResult = validateHttpEndpointForSsrf(endpoint);
    if (!ssrfResult.safe) {
      errors.push({
        code: 'E761',
        severity: 'error',
        message: `Endpoint blocked by SSRF protection: ${ssrfResult.reason || 'private/internal address'}`,
        field: 'endpoint',
      });
    }
  }

  // E734: Method required and valid
  if (!p.method) {
    errors.push({
      code: 'E734',
      severity: 'error',
      message: 'HTTP tool requires a method (GET, POST, PUT, PATCH, DELETE)',
      field: 'method',
    });
  } else if (!VALID_HTTP_METHODS.has(p.method.toUpperCase())) {
    errors.push({
      code: 'E734',
      severity: 'error',
      message: `Invalid HTTP method "${p.method}". Must be one of: GET, POST, PUT, PATCH, DELETE`,
      field: 'method',
    });
  }

  // E735: Auth type valid
  if (p.auth && !VALID_AUTH_TYPES.has(p.auth)) {
    errors.push({
      code: 'E735',
      severity: 'error',
      message: `Invalid auth type "${p.auth}". Must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`,
      field: 'auth',
    });
  }

  // E736: Inline OAuth2 requires token_url. Auth-profile backed tools resolve
  // credentials from the referenced profile at runtime, so they must not be
  // blocked by missing inline auth_config.
  if (p.auth === 'oauth2_client' && !p.auth_profile && !p.token_url) {
    errors.push({
      code: 'E736',
      severity: 'error',
      message: 'OAuth2 client auth requires a token_url in auth_config',
      field: 'auth_config.token_url',
    });
  }

  // E737: Timeout range
  validateRuntimeNumberRange({
    value: p.timeout,
    fieldName: 'HTTP binding timeout',
    code: 'E737',
    field: 'timeout',
    min: MIN_TIMEOUT_MS,
    max: MAX_TIMEOUT_MS,
    message: `Timeout must be between ${MIN_TIMEOUT_MS}ms and ${MAX_TIMEOUT_MS}ms`,
    errors,
  });

  // E738: Retry range
  validateRuntimeNumberRange({
    value: p.retry,
    fieldName: 'HTTP binding retry',
    code: 'E738',
    field: 'retry',
    min: 0,
    max: 10,
    message: 'Retry count must be between 0 and 10',
    errors,
  });
}

function validateSandboxTool(
  parsed: ParsedToolDsl,
  errors: ValidationDiagnostic[],
  warnings: ValidationDiagnostic[],
): void {
  const p = parsed.properties;

  // E740: Runtime required
  if (!p.runtime) {
    errors.push({
      code: 'E740',
      severity: 'error',
      message: 'Sandbox tool requires a runtime (javascript or python)',
      field: 'runtime',
    });
  } else if (!VALID_RUNTIMES.has(p.runtime)) {
    errors.push({
      code: 'E741',
      severity: 'error',
      message: `Invalid runtime "${p.runtime}". Must be javascript or python`,
      field: 'runtime',
    });
  }

  // E742: Code required (check for pipe-syntax code block)
  const hasCode =
    p.code !== undefined ||
    parsed.rawContent.includes('code: |') ||
    parsed.rawContent.includes('code:');
  if (!hasCode) {
    errors.push({
      code: 'E742',
      severity: 'error',
      message: 'Sandbox tool requires a code block',
      field: 'code',
    });
  }

  /* v8 ignore start -- defensive: code size checks for inline code values, pipe blocks are separate */
  // E743: Code size
  if (p.code && p.code.length > MAX_CODE_SIZE) {
    errors.push({
      code: 'E743',
      severity: 'error',
      message: `Code content exceeds maximum size of ${MAX_CODE_SIZE} bytes`,
      field: 'code',
    });
  }

  // W741: Code size warning
  if (p.code && p.code.length > SANDBOX_CODE_WARNING_SIZE) {
    warnings.push({
      code: 'W741',
      severity: 'warning',
      message: `Code content exceeds ${SANDBOX_CODE_WARNING_SIZE} bytes. Large code blocks may impact compilation performance.`,
      field: 'code',
    });
  }
  /* v8 ignore stop */

  // E745: Memory range
  validateRuntimeNumberRange({
    value: p.memory_mb,
    fieldName: 'Sandbox binding memory_mb',
    code: 'E745',
    field: 'memory_mb',
    min: MIN_MEMORY_MB,
    max: MAX_MEMORY_MB,
    message: `Memory must be between ${MIN_MEMORY_MB}MB and ${MAX_MEMORY_MB}MB`,
    errors,
  });
}

function validateMcpTool(parsed: ParsedToolDsl, errors: ValidationDiagnostic[]): void {
  const p = parsed.properties;

  // E750: Server required
  if (!p.server) {
    errors.push({
      code: 'E750',
      severity: 'error',
      message: 'MCP tool requires a server name (references an mcp_server_configs entry)',
      field: 'server',
    });
  }
}

// ─── Phase 4: Security ──────────────────────────────────────────────────

function validateSecurity(
  parsed: ParsedToolDsl,
  errors: ValidationDiagnostic[],
  _warnings: ValidationDiagnostic[],
): void {
  // E760: Plaintext secret detection
  const sensitiveFields = ['client_secret', 'token_url', 'bearer'];
  for (const field of sensitiveFields) {
    const value = parsed.properties[field];
    if (!value) continue;

    // Skip template placeholders
    if (value.includes('{{secrets.') || value.includes('{{env.')) continue;

    for (const pattern of PLAINTEXT_SECRET_PATTERNS) {
      if (pattern.test(value)) {
        errors.push({
          code: 'E760',
          severity: 'error',
          message: `Field "${field}" appears to contain a plaintext secret. Use {{secrets.SECRET_NAME}} placeholder instead.`,
          field,
        });
        break;
      }
    }
  }
}

// ─── Phase 5: Trial Compile ──────────────────────────────────────────

/**
 * Attempt to compile the parsed DSL into an IR binding.
 * Catches malformed configs that pass structural validation but fail binding construction.
 */
function validateTrialCompile(parsed: ParsedToolDsl, errors: ValidationDiagnostic[]): void {
  try {
    switch (parsed.type) {
      case 'http':
        buildHttpBindingFromProps(parsed.properties, parsed.rawContent);
        break;
      case 'sandbox':
        buildSandboxBindingFromProps(parsed.properties, parsed.rawContent);
        break;
      case 'mcp':
        // MCP server existence check is done at resolution time, not validation
        break;
      case 'searchai':
        buildSearchAIBindingFromProps(parsed.properties);
        break;
      case 'workflow':
        buildWorkflowBindingFromProps(parsed.properties);
        break;
    }
    /* v8 ignore start */
  } catch (err) {
    errors.push({
      code: 'E739',
      severity: 'error',
      message: `Trial compile failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  /* v8 ignore stop */
}
