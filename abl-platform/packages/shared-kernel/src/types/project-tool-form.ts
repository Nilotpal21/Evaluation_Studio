/**
 * Project Tool Form Types
 *
 * Form data interfaces for tool creation/editing in Studio UI.
 * Each tool type has a typed form shape that maps 1:1 to the tool creation
 * wizard fields. The serializer converts form data → dslContent string.
 */

// ─── Base ────────────────────────────────────────────────────────────────

export interface ToolFormParameter {
  name: string;
  type: string;
  /** LLM-visible description — required for all parameters */
  description: string;
  required: boolean;
  enumValues?: string[];
  defaultValue?: string;
  /** JSON string for nested object properties or array item schema */
  objectSchema?: string;
}

interface ToolFormBase {
  name: string;
  toolType: 'http' | 'sandbox' | 'mcp' | 'workflow' | 'searchai';
  /** Tool description — required for LLM context */
  description: string;
  parameters: ToolFormParameter[];
  returnType: string;
}

// ─── HTTP ────────────────────────────────────────────────────────────────

export type RuntimeNumericValue = number | `{{config.${string}}}`;

export type HttpAuthType =
  | 'none'
  | 'bearer'
  | 'api_key'
  | 'oauth2_client'
  | 'oauth2_user'
  | 'custom';

export type HttpConsentMode = 'preflight' | 'inline';
export type HttpConnectionMode = 'per_user' | 'shared';

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

export interface HttpToolFormData extends ToolFormBase {
  toolType: 'http';
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth: HttpAuthType;
  authConfig?: HttpAuthConfig;
  authProfileRef?: string;
  authJit?: boolean;
  consentMode?: HttpConsentMode;
  connectionMode?: HttpConnectionMode;
  headers?: Array<{ key: string; value: string }>;
  queryParams?: Array<{ key: string; value: string }>;
  body?: string;
  bodyType?: 'json' | 'form' | 'xml' | 'text';
  bodySchema?: string;
  useBodySchema?: boolean;
  timeout?: RuntimeNumericValue;
  retry?: RuntimeNumericValue;
  retryDelay?: RuntimeNumericValue;
  rateLimit?: RuntimeNumericValue;
  circuitBreaker?: { threshold: RuntimeNumericValue; resetMs: RuntimeNumericValue };
  /** Protocol discriminator — 'soap' enables SOAP envelope wrapping */
  protocol?: 'rest' | 'soap';
  /** SOAP version to use when protocol === 'soap' */
  soapVersion?: '1.1' | '1.2';
  /** SOAPAction for SOAP requests — supports {{input.X}} placeholders */
  soapAction?: string;
  /** How to handle <soap:Fault> responses */
  onSoapFault?: 'error' | 'data';
  /**
   * How non-2xx HTTP responses are handled.
   * 'data' (default): returns { statusCode, body, is_error: true } as the tool result.
   * 'error': throws TOOL_HTTP_ERROR — opt-in legacy behaviour.
   */
  onHttpError?: 'error' | 'data';
}

// ─── Sandbox ─────────────────────────────────────────────────────────────

export interface SandboxToolFormData extends ToolFormBase {
  toolType: 'sandbox';
  runtime: 'javascript' | 'python';
  code: string;
  memoryMb?: RuntimeNumericValue;
  timeout?: RuntimeNumericValue;
}

// ─── MCP ─────────────────────────────────────────────────────────────────

export interface McpToolFormData extends ToolFormBase {
  toolType: 'mcp';
  server: string;
  serverTool?: string;
  transportType?: string;
  headers?: Array<{ key: string; value: string }>;
}

// ─── Workflow ────────────────────────────────────────────────────────────

export interface WorkflowToolFormData extends ToolFormBase {
  toolType: 'workflow';
  workflowId: string;
  workflowVersionId?: string;
  workflowVersion?: string;
  triggerId: string;
  mode: 'sync' | 'async';
  timeoutMs?: RuntimeNumericValue;
  paramMapping?: Record<string, string>;
}

// ─── SearchAI ─────────────────────────────────────────────────────────────

export interface SearchAIToolFormData extends ToolFormBase {
  toolType: 'searchai';
  indexId: string;
  /** Server-derived tenant binding. Studio APIs must inject this from auth context. */
  tenantId: string;
  kbName?: string;
}

// ─── Union ───────────────────────────────────────────────────────────────

export type ProjectToolFormData =
  | HttpToolFormData
  | SandboxToolFormData
  | McpToolFormData
  | WorkflowToolFormData
  | SearchAIToolFormData;
