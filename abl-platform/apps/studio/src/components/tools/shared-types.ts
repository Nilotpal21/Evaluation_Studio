/**
 * Shared type definitions for tool components
 *
 * Canonical source for all tool-related types used across Studio UI.
 * Consolidates duplicate interfaces to ensure consistency and strict typing.
 */

// Re-export ToolType from store as the single source of truth
export type { ToolType } from '../../store/tool-store';

// ─── Strict Union Types ──────────────────────────────────────────────────────

/** Valid HTTP methods for tool endpoints */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** Valid authentication types for HTTP tools */
export type HttpAuthType =
  | 'none'
  | 'api_key'
  | 'bearer'
  | 'oauth2_client'
  | 'oauth2_user'
  | 'custom';

export type HttpConsentMode = 'preflight' | 'inline';
export type HttpConnectionMode = 'per_user' | 'shared';

/** Valid sandbox runtime environments */
export type SandboxRuntime = 'javascript' | 'python';

/** Valid MCP transport types */
export type McpTransportType = 'sse' | 'http';

/** Valid request body content types */
export type BodyType = 'json' | 'form' | 'xml' | 'text';

/** SOAP protocol discriminator */
export type Protocol = 'rest' | 'soap';

/** SOAP version */
export type SoapVersion = '1.1' | '1.2';

/** How to handle <soap:Fault> responses */
export type OnSoapFault = 'error' | 'data';

/** Supported JSON Schema types for tool parameters */
export const PARAM_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'enum',
] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

// ─── Key-Value Entry Types ───────────────────────────────────────────────────

/** Header entry for HTTP and MCP tools */
export interface HeaderEntry {
  key: string;
  value: string;
}

/** Query parameter entry for HTTP tools */
export interface QueryParamEntry {
  key: string;
  value: string;
}

// ─── Parameter Definition ────────────────────────────────────────────────────

/** Single tool parameter definition — maps to a JSON Schema property */
export interface ParameterDefinition {
  /** Parameter name (valid JS identifier) */
  name: string;
  /** JSON Schema type */
  type: ParamType;
  /** LLM-visible description — tells the model what this parameter is for */
  description: string;
  /** Whether the LLM must always provide this parameter */
  required: boolean;
  /** Allowed values for enum type */
  enumValues?: string[];
  /** Default value (serialised as string; coerced at runtime) */
  defaultValue?: string;
  /** JSON Schema for object/array items (free-form JSON string) */
  objectSchema?: string;
}

// ─── JSON Schema Types ───────────────────────────────────────────────────────

/** JSON Schema property descriptor */
export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

/** JSON Schema root object */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

// ─── Tool Name Validation ────────────────────────────────────────────────────

/** Tool names: lowercase, start with letter, a-z 0-9 underscore, 2-64 chars */
export const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;

/** Validate a tool name and return a translated error or undefined if valid */
export function validateToolName(value: string, t: (key: string) => string): string | undefined {
  if (!value) return undefined;
  if (value.length < 2) return t('name_min_length');
  if (!TOOL_NAME_REGEX.test(value)) return t('name_pattern_error');
  return undefined;
}

// ─── Circuit Breaker Config ──────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  threshold: RuntimeNumericValue;
  resetMs: RuntimeNumericValue;
}

export type ConfigRuntimeNumericTemplate = `{{config.${string}}}`;
export type RuntimeNumericValue = number | ConfigRuntimeNumericTemplate;

// ─── Auth Config ────────────────────────────────────────────────────────────

/** Strongly typed auth configuration for HTTP tools */
export interface HttpAuthConfig {
  token?: string;
  apiKey?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  headerName?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
}

// ─── Per-Type Config Interfaces ──────────────────────────────────────────────

/** HTTP tool configuration */
export interface HttpConfig {
  endpoint: string;
  method: HttpMethod;
  authType: HttpAuthType;
  authConfig?: HttpAuthConfig;
  authProfileRef?: string;
  authJit?: boolean;
  consentMode?: HttpConsentMode;
  connectionMode?: HttpConnectionMode;
  headers?: HeaderEntry[];
  queryParams?: QueryParamEntry[];
  body?: string;
  bodyType?: BodyType;
  bodySchema?: string;
  useBodySchema?: boolean;
  timeoutMs?: RuntimeNumericValue;
  retryCount?: RuntimeNumericValue;
  retryDelayMs?: RuntimeNumericValue;
  rateLimitPerMinute?: RuntimeNumericValue;
  circuitBreaker?: CircuitBreakerConfig;
  /** Protocol — 'soap' enables SOAP envelope wrapping */
  protocol?: Protocol;
  /** SOAP version — required when protocol === 'soap' */
  soapVersion?: SoapVersion;
  /** SOAPAction for SOAP requests — supports {{input.X}} placeholders */
  soapAction?: string;
  /** How to handle <soap:Fault> responses */
  onSoapFault?: OnSoapFault;
  parameters?: ParameterDefinition[];
  returnType?: string;
}

/** Sandbox (code) tool configuration */
export interface SandboxConfig {
  runtime: SandboxRuntime;
  codeContent: string;
  memoryMb?: RuntimeNumericValue;
  timeoutMs?: RuntimeNumericValue;
  parameters?: ParameterDefinition[];
  returnType?: string;
}

/** MCP tool configuration */
export interface McpConfig {
  serverUrl: string;
  transportType: McpTransportType;
  headers: HeaderEntry[];
  serverToolName: string;
}

/** Workflow tool configuration */
export interface WorkflowConfig {
  workflowId: string;
  /**
   * Semver pin for the workflow version (e.g. 'v0.2.0' or 'draft').
   * When absent or empty, auto-resolve picks the latest active version.
   * Persisted into the binding DSL as `workflow_version`.
   */
  workflowVersion?: string;
  triggerId: string;
  mode: 'sync' | 'async';
  timeoutMs?: RuntimeNumericValue;
  paramMapping?: Record<string, string>;
  /**
   * LLM-facing parameters derived from the workflow's `start` node
   * `inputVariables`. Populated by WorkflowConfigForm when workflow + trigger
   * are selected; the create dialog forwards this to the backend so the
   * stored tool exposes the same params as the workflow expects.
   */
  parameters?: ParameterDefinition[];
}

// ─── Discriminated Union ─────────────────────────────────────────────────────

/** Type-safe union of all tool configs, discriminated by toolType */
export type ToolConfigMap = {
  http: HttpConfig;
  sandbox: SandboxConfig;
  mcp: McpConfig;
  workflow: WorkflowConfig;
};

/** Any tool config (when type is known at runtime) */
export type AnyToolConfig = HttpConfig | SandboxConfig | McpConfig | WorkflowConfig;

// ─── Config Change Handlers ──────────────────────────────────────────────────

/** Type-safe change handler for a specific tool config type */
export type ToolConfigChangeHandler<T extends AnyToolConfig> = (config: T) => void;

// Re-export ToolTestResult from store as the canonical test result type
export type { ToolTestResult } from '../../store/tool-store';
