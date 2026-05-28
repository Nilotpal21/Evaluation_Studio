import { ToolExecutionError } from '@agent-platform/shared';
import type {
  HttpBindingIR,
  SandboxBindingIR,
  ToolDefinition,
  WorkflowBindingIR,
} from '../../ir/schema.js';
import type { SecretsProvider } from './secrets-provider.js';

const CONFIG_RUNTIME_NUMBER_RE = /^\{\{config\.([A-Za-z_][A-Za-z0-9_]*)\}\}$/;

export type ConfigRuntimeNumericTemplate = `{{config.${string}}}`;
export type RuntimeNumericValue = number | ConfigRuntimeNumericTemplate;
export type ResolvedHttpBindingIR = Omit<
  HttpBindingIR,
  'timeout_ms' | 'retry' | 'rate_limit_per_minute' | 'circuit_breaker'
> & {
  timeout_ms?: number;
  retry?: { count: number; delay_ms: number };
  rate_limit_per_minute?: number;
  circuit_breaker?: { threshold: number; reset_ms: number };
};
export type ResolvedSandboxBindingIR = Omit<SandboxBindingIR, 'timeout_ms' | 'memory_mb'> & {
  timeout_ms?: number;
  memory_mb?: number;
};
export type ResolvedWorkflowBindingIR = Omit<WorkflowBindingIR, 'timeoutMs'> & {
  timeoutMs?: number;
};

interface RuntimeNumberContext {
  toolName: string;
  toolType?: string;
  path: string;
}

function throwRuntimeNumberError(ctx: RuntimeNumberContext, message: string): never {
  throw new ToolExecutionError({
    code: 'TOOL_EXECUTION_ERROR',
    message,
    toolName: ctx.toolName,
    toolType: ctx.toolType,
    retryable: false,
  });
}

export async function resolveRuntimeNumericValue(
  value: unknown,
  secrets: SecretsProvider | undefined,
  ctx: RuntimeNumberContext,
): Promise<number | undefined> {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throwRuntimeNumberError(ctx, `${ctx.path} for tool "${ctx.toolName}" must be finite`);
    }
    return value;
  }

  if (typeof value !== 'string') {
    throwRuntimeNumberError(
      ctx,
      `${ctx.path} for tool "${ctx.toolName}" must be a number or exact {{config.KEY}} placeholder`,
    );
  }

  const trimmed = value.trim();
  const templateMatch = trimmed.match(CONFIG_RUNTIME_NUMBER_RE);
  const resolved = templateMatch ? await secrets?.getConfigVar?.(templateMatch[1]) : trimmed;

  if (resolved === undefined) {
    throwRuntimeNumberError(
      ctx,
      `Undefined config variable "${templateMatch?.[1] ?? trimmed}" referenced by ${ctx.path} for tool "${ctx.toolName}"`,
    );
  }

  if (String(resolved).includes('{{')) {
    throwRuntimeNumberError(
      ctx,
      `${ctx.path} for tool "${ctx.toolName}" must resolve before execution`,
    );
  }

  const numeric = Number(String(resolved).trim());
  if (!Number.isFinite(numeric)) {
    throwRuntimeNumberError(
      ctx,
      `Config value for ${ctx.path} in tool "${ctx.toolName}" must resolve to a number`,
    );
  }

  return numeric;
}

export async function resolveToolRuntimeNumericFields(
  tool: ToolDefinition,
  secrets: SecretsProvider | undefined,
): Promise<ToolDefinition> {
  const resolved: ToolDefinition = {
    ...tool,
    hints: { ...tool.hints },
  };

  if (resolved.hints.timeout !== undefined) {
    resolved.hints.timeout = await resolveRuntimeNumericValue(resolved.hints.timeout, secrets, {
      toolName: resolved.name,
      toolType: resolved.tool_type,
      path: 'hints.timeout',
    });
  }

  if (tool.http_binding) {
    resolved.http_binding = await resolveHttpBindingRuntimeNumericFields(
      tool.name,
      tool.http_binding,
      secrets,
    );
  }

  if (tool.sandbox_binding) {
    resolved.sandbox_binding = await resolveSandboxBindingRuntimeNumericFields(
      tool.name,
      tool.sandbox_binding,
      secrets,
    );
  }

  if (tool.workflow_binding) {
    resolved.workflow_binding = await resolveWorkflowBindingRuntimeNumericFields(
      tool.name,
      tool.workflow_binding,
      secrets,
    );
  }

  return resolved;
}

export async function resolveHttpBindingRuntimeNumericFields(
  toolName: string,
  binding: HttpBindingIR,
  secrets: SecretsProvider | undefined,
): Promise<ResolvedHttpBindingIR> {
  const resolved = { ...binding } as ResolvedHttpBindingIR;
  delete resolved.retry;
  delete resolved.circuit_breaker;

  if (binding.timeout_ms !== undefined) {
    resolved.timeout_ms = await resolveRuntimeNumericValue(binding.timeout_ms, secrets, {
      toolName,
      toolType: 'http',
      path: 'http_binding.timeout_ms',
    });
  }
  if (binding.rate_limit_per_minute !== undefined) {
    resolved.rate_limit_per_minute = await resolveRuntimeNumericValue(
      binding.rate_limit_per_minute,
      secrets,
      {
        toolName,
        toolType: 'http',
        path: 'http_binding.rate_limit_per_minute',
      },
    );
  }
  if (binding.retry) {
    resolved.retry = {
      count: (await resolveRuntimeNumericValue(binding.retry.count, secrets, {
        toolName,
        toolType: 'http',
        path: 'http_binding.retry.count',
      }))!,
      delay_ms: (await resolveRuntimeNumericValue(binding.retry.delay_ms, secrets, {
        toolName,
        toolType: 'http',
        path: 'http_binding.retry.delay_ms',
      }))!,
    };
  }
  if (binding.circuit_breaker) {
    resolved.circuit_breaker = {
      threshold: (await resolveRuntimeNumericValue(binding.circuit_breaker.threshold, secrets, {
        toolName,
        toolType: 'http',
        path: 'http_binding.circuit_breaker.threshold',
      }))!,
      reset_ms: (await resolveRuntimeNumericValue(binding.circuit_breaker.reset_ms, secrets, {
        toolName,
        toolType: 'http',
        path: 'http_binding.circuit_breaker.reset_ms',
      }))!,
    };
  }

  return resolved;
}

export async function resolveSandboxBindingRuntimeNumericFields(
  toolName: string,
  binding: SandboxBindingIR,
  secrets: SecretsProvider | undefined,
): Promise<ResolvedSandboxBindingIR> {
  const resolved = { ...binding } as ResolvedSandboxBindingIR;
  delete resolved.timeout_ms;
  delete resolved.memory_mb;

  if (binding.timeout_ms !== undefined) {
    resolved.timeout_ms = await resolveRuntimeNumericValue(binding.timeout_ms, secrets, {
      toolName,
      toolType: 'sandbox',
      path: 'sandbox_binding.timeout_ms',
    });
  }
  if (binding.memory_mb !== undefined) {
    resolved.memory_mb = await resolveRuntimeNumericValue(binding.memory_mb, secrets, {
      toolName,
      toolType: 'sandbox',
      path: 'sandbox_binding.memory_mb',
    });
  }

  return resolved;
}

export async function resolveWorkflowBindingRuntimeNumericFields(
  toolName: string,
  binding: WorkflowBindingIR,
  secrets: SecretsProvider | undefined,
): Promise<ResolvedWorkflowBindingIR> {
  const resolved = { ...binding } as ResolvedWorkflowBindingIR;
  delete resolved.timeoutMs;

  if (binding.timeoutMs !== undefined) {
    resolved.timeoutMs = await resolveRuntimeNumericValue(binding.timeoutMs, secrets, {
      toolName,
      toolType: 'workflow',
      path: 'workflow_binding.timeoutMs',
    });
  }

  return resolved;
}
