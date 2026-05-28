/**
 * System Agent Handler — handles delegate invocations to system/* agents.
 *
 * System agents (e.g., `system/arch`) are platform-provided agents that
 * are defined outside the project's agent registry. When a FLOW DELEGATE
 * targets a system agent, this handler invokes the platform implementation
 * in-process so the runtime session remains the durable orchestration layer.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  ARCH_SYSTEM_AGENT_ID,
  isSystemAgent,
  getSystemAgentDefinition,
} from '@agent-platform/arch-ai/system-agent';
import {
  runArchSystemAgentInProcess,
  type ArchSystemAgentDriverOutcome,
} from '@agent-platform/arch-ai';
import { hasPermission } from '@agent-platform/shared-auth/rbac';

const log = createLogger('runtime:system-agent-handler');

// ─── Types ────────────────────────────────────────────────────────────────

export interface SystemAgentDelegateInput {
  /** Target system agent ID (e.g. system/arch) */
  target: string;
  /** Input data from the delegate step */
  input: Record<string, unknown>;
  /** Optional free-text message */
  message?: string;
  /** Tenant context */
  tenantId: string;
  /** Project context */
  projectId: string;
  /** User/principal context */
  userId?: string;
  /** Runtime permissions attached to the session principal */
  permissions?: string[];
  /** Timeout in ms */
  timeoutMs?: number;
}

export interface SystemAgentDelegateResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface SystemAgentPermissionCheckInput {
  target: string;
  permissions: readonly string[];
  principalId?: string;
  tenantId?: string;
  projectId?: string;
}

export interface SystemAgentHandlerDeps {
  runArchAgent?: (
    ctx: {
      tenantId: string;
      userId: string;
      permissions?: string[];
      projectId: string;
    },
    spec: { projectName: string; description: string; channels?: string[]; language?: string },
    options?: {
      correlationId?: string;
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
    },
  ) => Promise<ArchSystemAgentDriverOutcome>;
}

// ─── Handler ──────────────────────────────────────────────────────────────

/**
 * Check if a delegate target is a system agent.
 */
export { isSystemAgent };

export function validateSystemAgentRequiredPermissions(
  input: SystemAgentPermissionCheckInput,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): SystemAgentDelegateResult | null {
  const definition = getSystemAgentDefinition(input.target);
  const requiredPermissions = definition?.requiredPermissions ?? [];
  if (requiredPermissions.length === 0) {
    return null;
  }

  const missingPermission = requiredPermissions.find(
    (permission) => !hasPermission(input.permissions, permission),
  );
  if (!missingPermission) {
    return null;
  }

  onTraceEvent?.({
    type: 'delegate_complete',
    data: {
      to: input.target,
      success: false,
      systemAgent: true,
      error: 'permission_denied',
      principalId: input.principalId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      missingPermission,
      requiredPermissions,
    },
  });

  return {
    success: false,
    error: `Permission denied: missing required permission '${missingPermission}' for ${input.target}`,
  };
}

/**
 * Handle a delegate invocation to a system agent.
 *
 * Returns the result in the same shape as the RoutingExecutor's
 * handleDelegate return type.
 */
export async function handleSystemAgentDelegate(
  input: SystemAgentDelegateInput,
  deps: SystemAgentHandlerDeps = {},
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<SystemAgentDelegateResult> {
  const definition = getSystemAgentDefinition(input.target);
  if (!definition) {
    return {
      success: false,
      error: `Unknown system agent: ${input.target}`,
    };
  }

  // Emit delegate_start trace
  onTraceEvent?.({
    type: 'delegate_start',
    data: {
      to: input.target,
      purpose: definition.description,
      systemAgent: true,
      input: input.input,
    },
  });

  try {
    let result: SystemAgentDelegateResult;

    if (input.target === ARCH_SYSTEM_AGENT_ID) {
      result = await invokeArchSystemAgent(input, deps, onTraceEvent);
    } else {
      result = {
        success: false,
        error: `System agent ${input.target} is not yet implemented`,
      };
    }

    // Emit delegate_complete trace
    onTraceEvent?.({
      type: 'delegate_complete',
      data: {
        to: input.target,
        success: result.success,
        systemAgent: true,
        ...(result.error ? { error: result.error } : {}),
      },
    });

    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('System agent delegate failed', {
      target: input.target,
      error: message,
    });

    onTraceEvent?.({
      type: 'delegate_complete',
      data: {
        to: input.target,
        success: false,
        systemAgent: true,
        error: message,
      },
    });

    return {
      success: false,
      error: `System agent invocation failed: ${message}`,
    };
  }
}

// ─── Arch AI System Agent ─────────────────────────────────────────────────

async function invokeArchSystemAgent(
  input: SystemAgentDelegateInput,
  deps: SystemAgentHandlerDeps,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<SystemAgentDelegateResult> {
  // Build spec from delegate input
  const spec = buildSpecFromInput(input);
  if (!spec) {
    return {
      success: false,
      error:
        'Invalid input for system/arch: requires spec.projectName and spec.description, or projectName and description as direct input fields',
    };
  }

  if (!input.tenantId || !input.projectId) {
    return {
      success: false,
      error: 'Invalid runtime context for system/arch: tenantId and projectId are required',
    };
  }

  const userId = input.userId ?? 'runtime-system-agent';
  const runArchAgent = deps.runArchAgent ?? runArchSystemAgentInProcess;

  log.info('Invoking system/arch in-process via delegate', {
    tenantId: input.tenantId,
    projectId: input.projectId,
    projectName: spec.projectName,
  });

  const envelope = await runArchAgent(
    {
      tenantId: input.tenantId,
      userId,
      permissions: input.permissions,
      projectId: input.projectId,
    },
    spec,
    {
      onTraceEvent,
    },
  );

  if (!envelope.success) {
    const code = envelope.error.code;
    const msg = envelope.error.message;
    return {
      success: false,
      error: `system/arch error (${code}): ${msg}`,
    };
  }

  onTraceEvent?.({
    type: 'system_arch_result',
    data: {
      projectId: envelope.data.projectId,
      agentCount: envelope.data.agents.length,
      topologyAgentCount: envelope.data.topology.agents.length,
    },
  });

  return {
    success: true,
    result: envelope.data,
  };
}

/**
 * Extract a spec from the delegate input.
 *
 * Supports multiple input shapes:
 * - { spec: { projectName, description } }
 * - { projectName, description }
 * - message text (used as description)
 */
function buildSpecFromInput(
  input: SystemAgentDelegateInput,
): { projectName: string; description: string; channels?: string[]; language?: string } | null {
  const data = input.input;

  // Shape 1: { spec: { projectName, description } }
  if (data.spec && typeof data.spec === 'object') {
    const spec = data.spec as Record<string, unknown>;
    if (typeof spec.projectName === 'string' && typeof spec.description === 'string') {
      return {
        projectName: spec.projectName,
        description: spec.description,
        channels: Array.isArray(spec.channels)
          ? spec.channels.filter((c): c is string => typeof c === 'string')
          : undefined,
        language: typeof spec.language === 'string' ? spec.language : undefined,
      };
    }
  }

  // Shape 2: { projectName, description }
  if (typeof data.projectName === 'string' && typeof data.description === 'string') {
    return {
      projectName: data.projectName,
      description: data.description,
      channels: Array.isArray(data.channels)
        ? data.channels.filter((c): c is string => typeof c === 'string')
        : undefined,
      language: typeof data.language === 'string' ? data.language : undefined,
    };
  }

  // Shape 3: message text as description
  if (input.message && input.message.trim().length > 0) {
    return {
      projectName: 'Generated Project',
      description: input.message,
    };
  }

  return null;
}
