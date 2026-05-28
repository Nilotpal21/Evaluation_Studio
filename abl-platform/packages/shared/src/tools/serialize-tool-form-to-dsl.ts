/**
 * Serialize Tool Form to DSL
 *
 * Converts typed form data (from Studio UI tool wizard) to a validated
 * DSL content string for storage in project_tools.dslContent.
 *
 * Output format matches the parser's expected tool DSL syntax:
 *   name(param: type, ...) -> returnType
 *     description: "..."
 *     type: http|sandbox|mcp
 *     ...type-specific properties
 */

import type {
  ProjectToolFormData,
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
  WorkflowToolFormData,
  SearchAIToolFormData,
  ToolFormParameter,
} from '../types/project-tool-form.js';
import { normalizeHttpAuthConfig } from './http-auth-config-normalizer.js';

/**
 * Serialize a tool form data object to a DSL content string.
 *
 * @param form - The typed form data from the tool wizard
 * @returns A validated DSL string ready for storage in dslContent
 */
export function serializeToolFormToDsl(form: ProjectToolFormData): string {
  const lines: string[] = [];

  // ─── Signature line ────────────────────────────────────────────────
  lines.push(buildSignatureLine(form.name, form.parameters, form.returnType));

  // ─── Common properties ─────────────────────────────────────────────
  if (form.description) {
    lines.push(`  description: ${inlineQuote(form.description)}`);
  }
  lines.push(`  type: ${form.toolType}`);

  // ─── Per-parameter metadata (description, enum, default) ──────────
  serializeParamMetadata(form.parameters, lines);

  // ─── Type-specific properties ──────────────────────────────────────
  switch (form.toolType) {
    case 'http':
      serializeHttpProperties(form, lines);
      break;
    case 'sandbox':
      serializeSandboxProperties(form, lines);
      break;
    case 'mcp':
      serializeMcpProperties(form, lines);
      break;
    case 'workflow':
      serializeWorkflowProperties(form as WorkflowToolFormData, lines);
      break;
    case 'searchai':
      serializeSearchAIProperties(form as SearchAIToolFormData, lines);
      break;
  }

  return lines.join('\n');
}

// ─── Signature ───────────────────────────────────────────────────────────

function buildSignatureLine(
  name: string,
  parameters: ToolFormParameter[],
  returnType: string,
): string {
  const params = parameters
    .map((p) => {
      const req = p.required ? '' : '?';
      return `${p.name}${req}: ${p.type}`;
    })
    .join(', ');

  return `${name}(${params}) -> ${returnType || 'object'}`;
}

// ─── HTTP ────────────────────────────────────────────────────────────────

function serializeHttpProperties(form: HttpToolFormData, lines: string[]): void {
  const authConfig = normalizeHttpAuthConfig(form.auth, form.authConfig, {
    authProfileRef: form.authProfileRef,
  });

  lines.push(`  endpoint: ${inlineQuote(form.endpoint)}`);
  lines.push(`  method: ${form.method}`);
  if (form.authProfileRef) {
    lines.push(`  auth_profile: ${inlineQuote(form.authProfileRef)}`);
  }
  if (form.authJit) {
    lines.push('  auth_jit: true');
  }
  if (form.consentMode) {
    lines.push(`  consent: ${form.consentMode}`);
  }
  if (form.connectionMode) {
    lines.push(`  connection: ${form.connectionMode}`);
  }
  if (form.authProfileRef && authConfig?.scopes) {
    lines.push(`  scopes: ${inlineQuote(authConfig.scopes)}`);
  }

  if (form.auth && form.auth !== 'none') {
    lines.push(`  auth: ${form.auth}`);

    if (authConfig) {
      const authConfigLines: string[] = [];
      if (authConfig.token) authConfigLines.push(`    token: ${inlineQuote(authConfig.token)}`);
      if (authConfig.apiKey) authConfigLines.push(`    api_key: ${inlineQuote(authConfig.apiKey)}`);
      if (authConfig.tokenUrl)
        authConfigLines.push(`    token_url: ${inlineQuote(authConfig.tokenUrl)}`);
      if (authConfig.clientId)
        authConfigLines.push(`    client_id: ${inlineQuote(authConfig.clientId)}`);
      if (authConfig.clientSecret)
        authConfigLines.push(`    client_secret: ${inlineQuote(authConfig.clientSecret)}`);
      if (authConfig.scopes && !form.authProfileRef)
        authConfigLines.push(`    scopes: ${inlineQuote(authConfig.scopes)}`);
      if (authConfig.headerName)
        authConfigLines.push(`    header_name: ${inlineQuote(authConfig.headerName)}`);
      if (authConfig.provider)
        authConfigLines.push(`    provider: ${inlineQuote(authConfig.provider)}`);
      if (authConfig.customHeaders && Object.keys(authConfig.customHeaders).length > 0) {
        authConfigLines.push('    custom_headers:');
        for (const [key, value] of Object.entries(authConfig.customHeaders)) {
          authConfigLines.push(`      ${key}: ${inlineQuote(value)}`);
        }
      }

      if (authConfigLines.length > 0) {
        lines.push('  auth_config:');
        lines.push(...authConfigLines);
      }
    }
  }

  if (form.protocol === 'soap') {
    lines.push('  protocol: soap');
    lines.push(`  soap_version: ${form.soapVersion ?? '1.1'}`);
    if (form.soapAction) {
      lines.push(`  soap_action: ${inlineQuote(form.soapAction)}`);
    }
    if (form.onSoapFault && form.onSoapFault !== 'error') {
      lines.push(`  on_soap_fault: ${form.onSoapFault}`);
    }
  }
  if (form.onHttpError === 'error') {
    lines.push(`  on_http_error: error`);
  }

  if (form.queryParams && form.queryParams.length > 0) {
    lines.push('  query_params:');
    for (const qp of form.queryParams) {
      lines.push(`    ${qp.key}: ${inlineQuote(qp.value)}`);
    }
  }

  if (form.bodyType) {
    lines.push(`  body_type: ${form.bodyType}`);
  }
  if (form.useBodySchema) {
    lines.push('  use_body_schema: true');
  }
  if (form.bodySchema) {
    lines.push('  body_schema: |');
    for (const schemaLine of form.bodySchema.split('\n')) {
      lines.push(`    ${schemaLine}`);
    }
  }

  if (form.body) {
    lines.push('  body: |');
    for (const bodyLine of form.body.split('\n')) {
      lines.push(`    ${bodyLine}`);
    }
  }

  if (form.headers && form.headers.length > 0) {
    lines.push('  headers:');
    for (const h of form.headers) {
      lines.push(`    ${h.key}: ${inlineQuote(h.value)}`);
    }
  }

  if (shouldSerializeRuntimeNumber(form.timeout, 30_000)) {
    lines.push(`  timeout: ${form.timeout}`);
  }
  if (
    form.retry != null &&
    (typeof form.retry === 'string' || (typeof form.retry === 'number' && form.retry > 0))
  ) {
    lines.push(`  retry: ${form.retry}`);
  }
  if (shouldSerializeRuntimeNumber(form.retryDelay, 1000)) {
    lines.push(`  retry_delay: ${form.retryDelay}`);
  }
  if (form.rateLimit != null) {
    lines.push(`  rate_limit: ${form.rateLimit}`);
  }
  if (form.circuitBreaker) {
    lines.push('  circuit_breaker:');
    lines.push(`    threshold: ${form.circuitBreaker.threshold}`);
    lines.push(`    reset_ms: ${form.circuitBreaker.resetMs}`);
  }
}

// ─── Sandbox ─────────────────────────────────────────────────────────────

function serializeSandboxProperties(form: SandboxToolFormData, lines: string[]): void {
  lines.push(`  runtime: ${inlineQuote(form.runtime)}`);

  if (shouldSerializeRuntimeNumber(form.memoryMb, 128)) {
    lines.push(`  memory_mb: ${form.memoryMb}`);
  }
  if (shouldSerializeRuntimeNumber(form.timeout, 5000)) {
    lines.push(`  timeout: ${form.timeout}`);
  }

  // Code uses pipe syntax (code: |)
  lines.push('  code: |');
  for (const codeLine of form.code.split('\n')) {
    lines.push(`    ${codeLine}`);
  }
}

// ─── MCP ─────────────────────────────────────────────────────────────────

function serializeMcpProperties(form: McpToolFormData, lines: string[]): void {
  lines.push(`  server: ${inlineQuote(form.server)}`);
  if (form.serverTool) {
    lines.push(`  server_tool: ${inlineQuote(form.serverTool)}`);
  }
  if (form.transportType && form.transportType !== 'sse') {
    lines.push(`  transport_type: ${form.transportType}`);
  }
  if (form.headers && form.headers.length > 0) {
    lines.push('  headers:');
    for (const h of form.headers) {
      lines.push(`    ${h.key}: ${inlineQuote(h.value)}`);
    }
  }
}

// ─── Workflow ───────────────────────────────────────────────────────────

function serializeWorkflowProperties(form: WorkflowToolFormData, lines: string[]): void {
  lines.push(`  workflow_id: ${inlineQuote(form.workflowId)}`);
  if (form.workflowVersionId) {
    lines.push(`  workflow_version_id: ${inlineQuote(form.workflowVersionId)}`);
  }
  if (form.workflowVersion) {
    lines.push(`  workflow_version: ${inlineQuote(form.workflowVersion)}`);
  }
  lines.push(`  trigger_id: ${inlineQuote(form.triggerId)}`);
  if (form.mode && form.mode !== 'sync') {
    lines.push(`  mode: ${form.mode}`);
  }
  if (form.timeoutMs !== undefined) {
    lines.push(`  timeout_ms: ${form.timeoutMs}`);
  }
  if (form.paramMapping && Object.keys(form.paramMapping).length > 0) {
    lines.push(`  param_mapping: ${JSON.stringify(form.paramMapping)}`);
  }
}

// ─── SearchAI ─────────────────────────────────────────────────────────────

function serializeSearchAIProperties(form: SearchAIToolFormData, lines: string[]): void {
  lines.push(`  index_id: ${inlineQuote(form.indexId)}`);
  lines.push(`  tenant_id: ${inlineQuote(form.tenantId)}`);
  if (form.kbName) {
    lines.push(`  kb_name: ${inlineQuote(form.kbName)}`);
  }
}

// ─── Parameter Metadata ──────────────────────────────────────────────────

/**
 * Serialize per-parameter metadata (description, enum, default) as a `params:` block.
 * Only emitted when at least one parameter has metadata beyond name/type/required.
 */
function serializeParamMetadata(parameters: ToolFormParameter[], lines: string[]): void {
  const hasMetadata = parameters.some(
    (p) =>
      p.description ||
      (p.enumValues && p.enumValues.length > 0) ||
      (p.defaultValue !== undefined && p.defaultValue !== '') ||
      p.objectSchema,
  );
  if (!hasMetadata) return;

  lines.push('  params:');
  for (const p of parameters) {
    const hasParamMeta =
      p.description ||
      (p.enumValues && p.enumValues.length > 0) ||
      (p.defaultValue !== undefined && p.defaultValue !== '') ||
      p.objectSchema;
    if (!hasParamMeta) continue;
    lines.push(`    ${p.name}:`);
    if (p.description) lines.push(`      description: ${inlineQuote(p.description)}`);
    if (p.enumValues && p.enumValues.length > 0) {
      lines.push(`      enum: ${p.enumValues.join(', ')}`);
    }
    if (p.defaultValue !== undefined && p.defaultValue !== '') {
      lines.push(`      default: ${inlineQuote(String(p.defaultValue))}`);
    }
    if (p.objectSchema) lines.push(`      schema: ${inlineQuote(p.objectSchema)}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Wrap a value in quotes if it contains spaces or special characters.
 * Otherwise return it bare.
 */
function inlineQuote(value: string): string {
  if (/[\s:#"'{}[\],]/.test(value) || value.length === 0) {
    // Escape internal double quotes
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

function shouldSerializeRuntimeNumber(value: number | string | undefined, defaultValue: number) {
  return value != null && (typeof value === 'string' || value !== defaultValue);
}
