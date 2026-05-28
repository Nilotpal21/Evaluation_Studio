import { CONFIG_VAR_PATTERN, type AgentIR } from '@abl/compiler';

interface ConfigTemplateResolutionResult<T> {
  value: T;
  errors: string[];
}

const RUNTIME_CONFIG_TOOL_KEYS = [
  'auth_profile_ref',
  'workflow_binding',
  'searchai_binding',
  'http_binding',
  'mcp_binding',
  'sandbox_binding',
  'connector_binding',
  'async_webhook_binding',
] as const;

const PRESERVED_RUNTIME_TOOL_KEYS = new Set(['auth_profile_ref']);

const NAMESPACE_SCOPED_RUNTIME_TOOL_KEYS = new Set<string>(RUNTIME_CONFIG_TOOL_KEYS);

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveConfigTemplateString(
  value: string,
  configVars: Record<string, string>,
  context: string,
): { value: string; errors: string[] } {
  const errors: string[] = [];
  const pattern = new RegExp(CONFIG_VAR_PATTERN.source, CONFIG_VAR_PATTERN.flags);

  return {
    value: value.replace(pattern, (match, key: string) => {
      if (key in configVars) {
        return configVars[key];
      }

      errors.push(`Undefined config variable "${key}" referenced in ${context}`);
      return match;
    }),
    errors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceResolvedRuntimeNumber(
  value: unknown,
  path: string,
  context: string,
  errors: string[],
): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('{{')) {
    return value;
  }

  const numeric = Number(trimmed);
  if (Number.isNaN(numeric)) {
    errors.push(`Config value for ${path} in ${context} must resolve to a number, got "${value}"`);
    return value;
  }

  return numeric;
}

export function coerceToolRuntimeNumericFields(
  tool: Record<string, unknown>,
  context: string,
  errors: string[],
): void {
  const hints = tool.hints;
  if (isRecord(hints) && 'timeout' in hints) {
    hints.timeout = coerceResolvedRuntimeNumber(hints.timeout, 'hints.timeout', context, errors);
  }

  const httpBinding = tool.http_binding;
  if (isRecord(httpBinding)) {
    for (const path of ['timeout_ms', 'rate_limit_per_minute']) {
      if (path in httpBinding) {
        httpBinding[path] = coerceResolvedRuntimeNumber(
          httpBinding[path],
          `http_binding.${path}`,
          context,
          errors,
        );
      }
    }

    const retry = httpBinding.retry;
    if (isRecord(retry)) {
      for (const path of ['count', 'delay_ms']) {
        if (path in retry) {
          retry[path] = coerceResolvedRuntimeNumber(
            retry[path],
            `http_binding.retry.${path}`,
            context,
            errors,
          );
        }
      }
    }

    const circuitBreaker = httpBinding.circuit_breaker;
    if (isRecord(circuitBreaker)) {
      for (const path of ['threshold', 'reset_ms']) {
        if (path in circuitBreaker) {
          circuitBreaker[path] = coerceResolvedRuntimeNumber(
            circuitBreaker[path],
            `http_binding.circuit_breaker.${path}`,
            context,
            errors,
          );
        }
      }
    }
  }

  const sandboxBinding = tool.sandbox_binding;
  if (isRecord(sandboxBinding)) {
    for (const path of ['timeout_ms', 'memory_mb']) {
      if (path in sandboxBinding) {
        sandboxBinding[path] = coerceResolvedRuntimeNumber(
          sandboxBinding[path],
          `sandbox_binding.${path}`,
          context,
          errors,
        );
      }
    }
  }

  const workflowBinding = tool.workflow_binding;
  if (isRecord(workflowBinding) && 'timeoutMs' in workflowBinding) {
    workflowBinding.timeoutMs = coerceResolvedRuntimeNumber(
      workflowBinding.timeoutMs,
      'workflow_binding.timeoutMs',
      context,
      errors,
    );
  }
}

export function resolveConfigTemplatesInValue<T>(
  value: T,
  configVars: Record<string, string>,
  context: string,
): ConfigTemplateResolutionResult<T> {
  const cloned = cloneJson(value);
  const errors: string[] = [];

  function walk(node: unknown): unknown {
    if (typeof node === 'string') {
      const result = resolveConfigTemplateString(node, configVars, context);
      errors.push(...result.errors);
      return result.value;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        node[i] = walk(node[i]);
      }
      return node;
    }

    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        (node as Record<string, unknown>)[key] = walk((node as Record<string, unknown>)[key]);
      }
      return node;
    }

    return node;
  }

  return {
    value: walk(cloned) as T,
    errors,
  };
}

function hasNamespaceScopedVariables(tool: Record<string, unknown>): boolean {
  const namespaceIds = tool.variable_namespace_ids;
  return Array.isArray(namespaceIds) && namespaceIds.length > 0;
}

export function resolveRuntimeConfigKeysInAgentIR(
  ir: AgentIR,
  configVars: Record<string, string>,
  context: string,
): { ir: AgentIR; errors: string[] } {
  const cloned = cloneJson(ir) as AgentIR & { tools?: Array<Record<string, unknown>> };
  const errors: string[] = [];

  if (!Array.isArray(cloned.tools)) {
    cloned.tools = [];
  }

  const tools = cloned.tools as Array<Record<string, unknown>>;
  for (const tool of tools) {
    const isNamespaceScopedTool = hasNamespaceScopedVariables(tool);

    for (const key of RUNTIME_CONFIG_TOOL_KEYS) {
      if (!(key in tool)) {
        continue;
      }

      if (PRESERVED_RUNTIME_TOOL_KEYS.has(key)) {
        continue;
      }

      if (isNamespaceScopedTool && NAMESPACE_SCOPED_RUNTIME_TOOL_KEYS.has(key)) {
        continue;
      }

      const result =
        typeof tool[key] === 'string'
          ? resolveConfigTemplateString(tool[key] as string, configVars, context)
          : resolveConfigTemplatesInValue(tool[key], configVars, context);
      tool[key] = result.value;
      errors.push(...result.errors);
    }

    coerceToolRuntimeNumericFields(tool, context, errors);
  }

  return { ir: cloned as AgentIR, errors };
}
