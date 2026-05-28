/**
 * Form Adapters
 *
 * Bidirectional adapters between the shared ProjectToolFormData types
 * (used by the DSL serializer/parser) and the UI wizard config interfaces
 * (HttpConfig, SandboxConfig, McpConfig used by the config form components).
 */

import type {
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
  RuntimeNumericValue,
} from '@agent-platform/shared/types';
import { normalizeHttpAuthConfig } from '@agent-platform/shared/tools';
import type {
  HttpConfig,
  HttpAuthConfig as StudioHttpAuthConfig,
  SandboxConfig,
  McpConfig,
  WorkflowConfig,
  HttpMethod,
  HttpAuthType as StudioAuthType,
  SandboxRuntime,
  McpTransportType,
  ParamType,
  ParameterDefinition,
} from './shared-types';
import type { createTool } from '../../api/tools';

/** Payload shape accepted by the createTool API function */
export type CreateToolPayload = Parameters<typeof createTool>[1];

const HTTP_AUTH_FIELDS_BY_TYPE: Record<StudioAuthType, Array<keyof StudioHttpAuthConfig>> = {
  none: [],
  api_key: ['headerName', 'apiKey'],
  bearer: ['token'],
  oauth2_client: ['clientId', 'clientSecret', 'tokenUrl', 'scopes'],
  oauth2_user: ['provider', 'scopes'],
  custom: ['customHeaders'],
};

function sanitizeHttpAuthConfig(
  authType: StudioAuthType,
  authConfig: StudioHttpAuthConfig | undefined,
  options?: {
    hasAuthProfileRef?: boolean;
  },
): StudioHttpAuthConfig | undefined {
  if (!authConfig || authType === 'none') return undefined;

  const hasAuthProfileRef = options?.hasAuthProfileRef === true;
  const allowedFields = hasAuthProfileRef
    ? (['scopes'] as Array<keyof StudioHttpAuthConfig>)
    : (HTTP_AUTH_FIELDS_BY_TYPE[authType] ?? []);

  const sanitized: StudioHttpAuthConfig = {};
  for (const field of allowedFields) {
    const value = authConfig[field];
    if (value === undefined) continue;

    if (field === 'customHeaders') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value).filter(([key]) => key.trim().length > 0);
        if (entries.length > 0) {
          sanitized.customHeaders = Object.fromEntries(entries);
        }
      }
      continue;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      sanitized[field] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

// ─── Form → Wizard Config ─────────────────────────────────────────────────────

export function toolFormToHttpConfig(form: HttpToolFormData): HttpConfig {
  const config: HttpConfig = {
    endpoint: form.endpoint,
    method: form.method as HttpMethod,
    authType: form.auth as StudioAuthType,
  };
  const retryCount = runtimeNumericValue(form.retry);
  if (retryCount !== undefined || form.retry === undefined) {
    config.retryCount = retryCount ?? 0;
  }
  const retryDelayMs = runtimeNumericValue(form.retryDelay);
  if (retryDelayMs !== undefined || form.retryDelay === undefined) {
    config.retryDelayMs = retryDelayMs ?? 1000;
  }

  if (form.authProfileRef) config.authProfileRef = form.authProfileRef;
  if (form.authJit !== undefined) config.authJit = form.authJit;
  if (form.consentMode) config.consentMode = form.consentMode;
  if (form.connectionMode) config.connectionMode = form.connectionMode;

  // Auth config mapping — typed field-by-field to avoid lossy Record<string, string>
  if (form.authConfig) {
    const ac: StudioHttpAuthConfig = {};
    if (form.authConfig.token) ac.token = form.authConfig.token;
    if (form.authConfig.apiKey) ac.apiKey = form.authConfig.apiKey;
    if (form.authConfig.tokenUrl) ac.tokenUrl = form.authConfig.tokenUrl;
    if (form.authConfig.clientId) ac.clientId = form.authConfig.clientId;
    if (form.authConfig.clientSecret) ac.clientSecret = form.authConfig.clientSecret;
    if (form.authConfig.scopes) ac.scopes = form.authConfig.scopes;
    if (form.authConfig.headerName) ac.headerName = form.authConfig.headerName;
    if (form.authConfig.provider) ac.provider = form.authConfig.provider;
    if (form.authConfig.customHeaders) {
      // Keep as Record<string, string> — no JSON stringification
      ac.customHeaders =
        typeof form.authConfig.customHeaders === 'string'
          ? JSON.parse(form.authConfig.customHeaders)
          : form.authConfig.customHeaders;
    }
    config.authConfig = sanitizeHttpAuthConfig(config.authType, ac, {
      hasAuthProfileRef: Boolean(form.authProfileRef?.trim()),
    });
  }

  if (form.headers && form.headers.length > 0) {
    config.headers = form.headers.map((h: { key: string; value: string }) => ({
      key: h.key,
      value: h.value,
    }));
  }

  if (form.queryParams && form.queryParams.length > 0) {
    config.queryParams = form.queryParams.map((q: { key: string; value: string }) => ({
      key: q.key,
      value: q.value,
    }));
  }

  if (form.body) config.body = form.body;
  if (form.bodyType) config.bodyType = form.bodyType;
  if (form.bodySchema) config.bodySchema = form.bodySchema;
  if (form.useBodySchema) config.useBodySchema = form.useBodySchema;

  if (form.timeout != null) config.timeoutMs = runtimeNumericValue(form.timeout);
  if (form.rateLimit != null) config.rateLimitPerMinute = runtimeNumericValue(form.rateLimit);
  if (
    form.circuitBreaker &&
    runtimeNumericValue(form.circuitBreaker.threshold) !== undefined &&
    runtimeNumericValue(form.circuitBreaker.resetMs) !== undefined
  ) {
    config.circuitBreaker = {
      threshold: runtimeNumericValue(form.circuitBreaker.threshold)!,
      resetMs: runtimeNumericValue(form.circuitBreaker.resetMs)!,
    };
  }

  if (form.protocol) config.protocol = form.protocol;
  if (form.soapVersion) config.soapVersion = form.soapVersion;
  if (form.soapAction) config.soapAction = form.soapAction;
  if (form.onSoapFault) config.onSoapFault = form.onSoapFault;

  // Map parameters with full metadata
  if (form.parameters && form.parameters.length > 0) {
    config.parameters = form.parameters.map((p) => ({
      name: p.name,
      type: p.type as ParamType,
      description: p.description || '',
      required: p.required,
      ...(p.enumValues && { enumValues: p.enumValues }),
      ...(p.defaultValue !== undefined && { defaultValue: p.defaultValue }),
      ...(p.objectSchema && { objectSchema: p.objectSchema }),
    }));
  }

  config.returnType = form.returnType || 'object';

  return config;
}

export function toolFormToSandboxConfig(form: SandboxToolFormData): SandboxConfig {
  const config: SandboxConfig = {
    runtime: form.runtime as SandboxRuntime,
    codeContent: form.code,
    memoryMb: runtimeNumericValue(form.memoryMb),
    timeoutMs: runtimeNumericValue(form.timeout),
    returnType: form.returnType || 'object',
    parameters: form.parameters.map((p) => ({
      name: p.name,
      type: p.type as ParamType,
      description: p.description || '',
      required: p.required,
      ...(p.enumValues && { enumValues: p.enumValues }),
      ...(p.defaultValue !== undefined && { defaultValue: p.defaultValue }),
      ...(p.objectSchema && { objectSchema: p.objectSchema }),
    })),
  };

  return config;
}

export function toolFormToMcpConfig(form: McpToolFormData): McpConfig {
  return {
    serverUrl: form.server,
    transportType: (form.transportType || 'sse') as McpTransportType,
    headers: form.headers ?? [],
    serverToolName: form.serverTool || '',
  };
}

// ─── Wizard Config → Form (for save) ─────────────────────────────────────────

function paramDefsToFormParams(params: ParameterDefinition[] | undefined): Array<{
  name: string;
  type: string;
  description: string;
  required: boolean;
  enumValues?: string[];
  defaultValue?: string;
  objectSchema?: string;
}> {
  if (!params || params.length === 0) return [];
  return params.map((p) => ({
    name: p.name,
    type: p.type,
    required: p.required,
    description: p.description || '',
    ...(p.enumValues?.length && { enumValues: p.enumValues }),
    ...(p.defaultValue !== undefined && p.defaultValue !== '' && { defaultValue: p.defaultValue }),
    ...(p.objectSchema && { objectSchema: p.objectSchema }),
  }));
}

export function httpConfigToToolForm(
  name: string,
  description: string | null | undefined,
  config: HttpConfig,
  existingForm: HttpToolFormData | null,
): HttpToolFormData {
  const hasAuthProfileRef = Boolean(config.authProfileRef?.trim());
  const sanitizedAuthConfig = sanitizeHttpAuthConfig(
    (config.authType || 'none') as StudioAuthType,
    config.authConfig,
    { hasAuthProfileRef },
  );

  // Use config.parameters if defined (even empty = user cleared them), fall back to existingForm
  const parameters =
    config.parameters !== undefined
      ? paramDefsToFormParams(config.parameters)
      : (existingForm?.parameters ?? []);
  const auth = (config.authType || 'none') as HttpToolFormData['auth'];
  const authConfig = normalizeHttpAuthConfig(auth, config.authConfig, {
    authProfileRef: config.authProfileRef,
  });

  return {
    name,
    toolType: 'http',
    description: description || '',
    parameters,
    returnType: config.returnType || existingForm?.returnType || 'object',
    endpoint: config.endpoint,
    method: config.method as HttpToolFormData['method'],
    auth,
    ...(sanitizedAuthConfig && { authConfig: sanitizedAuthConfig }),
    ...(config.authProfileRef && { authProfileRef: config.authProfileRef }),
    ...(hasAuthProfileRef && config.authJit !== undefined && { authJit: config.authJit }),
    ...(hasAuthProfileRef && config.consentMode && { consentMode: config.consentMode }),
    ...(hasAuthProfileRef && config.connectionMode && { connectionMode: config.connectionMode }),
    ...(config.headers?.length && { headers: config.headers }),
    ...(config.queryParams?.length && { queryParams: config.queryParams }),
    ...(config.body && { body: config.body }),
    bodyType: config.bodyType || 'json',
    ...(config.bodySchema && { bodySchema: config.bodySchema }),
    ...(config.useBodySchema && { useBodySchema: config.useBodySchema }),
    ...runtimeNumericField('timeout', config.timeoutMs, existingForm?.timeout),
    ...runtimeNumericField('retry', config.retryCount, existingForm?.retry),
    ...runtimeNumericField('retryDelay', config.retryDelayMs, existingForm?.retryDelay),
    ...runtimeNumericField('rateLimit', config.rateLimitPerMinute, existingForm?.rateLimit),
    ...(config.circuitBreaker
      ? { circuitBreaker: config.circuitBreaker }
      : existingForm?.circuitBreaker
        ? { circuitBreaker: existingForm.circuitBreaker }
        : {}),
    ...(config.protocol && { protocol: config.protocol }),
    ...(config.soapVersion && { soapVersion: config.soapVersion }),
    ...(config.soapAction !== undefined && { soapAction: config.soapAction }),
    ...(config.onSoapFault && { onSoapFault: config.onSoapFault }),
  };
}

export function sandboxConfigToToolForm(
  name: string,
  description: string | null | undefined,
  config: SandboxConfig,
  existingForm?: SandboxToolFormData | null,
): SandboxToolFormData {
  return {
    name,
    toolType: 'sandbox',
    description: description || '',
    parameters: paramDefsToFormParams(config.parameters),
    returnType: config.returnType || 'object',
    runtime: config.runtime as SandboxToolFormData['runtime'],
    code: config.codeContent,
    ...runtimeNumericField('memoryMb', config.memoryMb, existingForm?.memoryMb),
    ...runtimeNumericField('timeout', config.timeoutMs, existingForm?.timeout),
  };
}

export function mcpConfigToToolForm(
  name: string,
  description: string | null | undefined,
  config: McpConfig,
  existingForm: McpToolFormData | null,
): McpToolFormData {
  return {
    name,
    toolType: 'mcp',
    description: description || '',
    parameters: existingForm?.parameters ?? [],
    returnType: existingForm?.returnType ?? 'object',
    server: config.serverUrl,
    ...(config.serverToolName && { serverTool: config.serverToolName }),
    ...(config.transportType && { transportType: config.transportType }),
    ...(config.headers?.length && { headers: config.headers }),
  };
}

function runtimeNumericValue(
  value: RuntimeNumericValue | undefined,
): RuntimeNumericValue | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

function runtimeNumericField<K extends string>(
  key: K,
  value: RuntimeNumericValue | undefined,
  existing: RuntimeNumericValue | undefined,
): { [P in K]?: RuntimeNumericValue } {
  const nextValue = value ?? existing;
  return nextValue != null ? ({ [key]: nextValue } as { [P in K]: RuntimeNumericValue }) : {};
}

// ─── Create-Tool Payload Builders ────────────────────────────────────────────
//
// Single source of truth for flattening UI config → API payload.
// Replaces duplicated logic in ToolCreateDialog & ToolCreatePage.

function mapParameters(params: ParameterDefinition[] | undefined) {
  return (params ?? []).map((p) => ({
    name: p.name,
    type: p.type,
    description: p.description,
    required: p.required,
    ...(p.enumValues?.length && { enumValues: p.enumValues }),
    ...(p.defaultValue && { defaultValue: p.defaultValue }),
    ...(p.objectSchema && { objectSchema: p.objectSchema }),
  }));
}

export function buildHttpCreatePayload(
  name: string,
  description: string,
  cfg: HttpConfig,
): CreateToolPayload {
  const hasAuthProfileRef = Boolean(cfg.authProfileRef?.trim());
  const sanitizedAuthConfig = sanitizeHttpAuthConfig(
    (cfg.authType || 'none') as StudioAuthType,
    cfg.authConfig,
    { hasAuthProfileRef },
  );
  const parameters = mapParameters(cfg.parameters);
  const authConfig = normalizeHttpAuthConfig(cfg.authType, cfg.authConfig, {
    authProfileRef: cfg.authProfileRef,
  });

  return {
    name,
    toolType: 'http',
    description: description || undefined,
    endpoint: cfg.endpoint,
    method: cfg.method,
    auth: cfg.authType,
    ...(sanitizedAuthConfig && { authConfig: sanitizedAuthConfig }),
    ...(cfg.authProfileRef && { authProfileRef: cfg.authProfileRef }),
    ...(hasAuthProfileRef && cfg.authJit !== undefined && { authJit: cfg.authJit }),
    ...(hasAuthProfileRef && cfg.consentMode && { consentMode: cfg.consentMode }),
    ...(hasAuthProfileRef && cfg.connectionMode && { connectionMode: cfg.connectionMode }),
    ...(cfg.headers?.length && { headers: cfg.headers.filter((h) => h.key.trim()) }),
    ...(cfg.queryParams?.length && { queryParams: cfg.queryParams.filter((q) => q.key.trim()) }),
    ...(cfg.body && { body: cfg.body }),
    ...(cfg.bodyType && { bodyType: cfg.bodyType }),
    ...(cfg.bodySchema && { bodySchema: cfg.bodySchema }),
    ...(cfg.useBodySchema && { useBodySchema: cfg.useBodySchema }),
    ...(cfg.timeoutMs != null &&
      (typeof cfg.timeoutMs === 'string' || cfg.timeoutMs !== 30_000) && {
        timeout: cfg.timeoutMs,
      }),
    ...(cfg.retryCount !== undefined &&
      (typeof cfg.retryCount === 'string' || cfg.retryCount > 0) && { retry: cfg.retryCount }),
    ...(cfg.retryDelayMs !== undefined &&
      (typeof cfg.retryDelayMs === 'string' || cfg.retryDelayMs !== 1000) && {
        retryDelay: cfg.retryDelayMs,
      }),
    ...(cfg.rateLimitPerMinute != null && { rateLimit: cfg.rateLimitPerMinute }),
    ...(cfg.circuitBreaker && { circuitBreaker: cfg.circuitBreaker }),
    ...(parameters.length > 0 && { parameters }),
    returnType: cfg.returnType || 'object',
  };
}

export function buildSandboxCreatePayload(
  name: string,
  description: string,
  cfg: SandboxConfig,
): CreateToolPayload {
  const parameters = mapParameters(cfg.parameters);
  return {
    name,
    toolType: 'sandbox',
    description: description || undefined,
    runtime: cfg.runtime,
    code: cfg.codeContent,
    ...(cfg.memoryMb != null && { memoryMb: cfg.memoryMb }),
    ...(cfg.timeoutMs != null &&
      (typeof cfg.timeoutMs === 'string' || cfg.timeoutMs !== 5000) && {
        timeout: cfg.timeoutMs,
      }),
    ...(parameters.length > 0 && { parameters }),
    returnType: cfg.returnType || 'object',
  };
}

export function buildMcpCreatePayload(
  name: string,
  description: string,
  cfg: McpConfig,
): CreateToolPayload {
  return {
    name,
    toolType: 'mcp',
    description: description || undefined,
    server: cfg.serverUrl,
    ...(cfg.serverToolName && { serverTool: cfg.serverToolName }),
    ...(cfg.transportType && cfg.transportType !== 'sse' && { transportType: cfg.transportType }),
    ...(cfg.headers?.length && { headers: cfg.headers.filter((h) => h.key.trim()) }),
  };
}

export function buildWorkflowCreatePayload(
  name: string,
  description: string,
  cfg: WorkflowConfig,
): CreateToolPayload {
  return {
    name,
    toolType: 'workflow',
    description: description || undefined,
    workflowId: cfg.workflowId,
    ...(cfg.workflowVersion && { workflowVersion: cfg.workflowVersion }),
    triggerId: cfg.triggerId,
    mode: cfg.mode,
    ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
    ...(cfg.paramMapping && { paramMapping: cfg.paramMapping }),
    ...(cfg.parameters?.length && { parameters: mapParameters(cfg.parameters) }),
  };
}
