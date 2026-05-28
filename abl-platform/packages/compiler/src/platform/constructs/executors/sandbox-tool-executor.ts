/**
 * Sandbox Tool Executor
 *
 * Executes user-uploaded code in isolated sandboxes.
 * Code is baked into the IR at compile time (code_content field).
 * No entrypoint — code is executed directly.
 */

import type { ToolDefinition } from '../../ir/schema.js';
import type { SecretsProvider } from './secrets-provider.js';
import type { ToolMemoryAPI } from '../types.js';
import { resolveSandboxBindingRuntimeNumericFields } from './runtime-numeric-values.js';
import { createLogger } from '../../logger.js';
import { ToolExecutionError, DEFAULT_SANDBOX_TIMEOUT_MS } from '@agent-platform/shared';

const log = createLogger('sandbox-tool-executor');

/**
 * Validate code_content for path traversal, absolute paths, and null bytes.
 * Prevents sandbox escape via malicious entrypoint strings.
 *
 * Only applies to file-path references (single-line strings).
 * Inline code (multi-line, extracted from DSL `code: |` blocks) is sent
 * directly to the gvisor pod — no filesystem access, so path validation
 * is not applicable.
 */
function validateCodeContent(toolName: string, codeContent: string): void {
  // Inline code contains newlines — it's sent directly to the pod, not loaded from disk.
  // Path validation only applies to single-line file-path references.
  if (codeContent.includes('\n')) {
    return;
  }

  if (codeContent.includes('\0')) {
    throw new ToolExecutionError({
      code: 'TOOL_EXECUTION_ERROR',
      message: `Sandbox tool "${toolName}" code_content contains null bytes`,
      toolName,
      toolType: 'sandbox',
    });
  }
  if (codeContent.includes('..')) {
    throw new ToolExecutionError({
      code: 'TOOL_EXECUTION_ERROR',
      message: `Sandbox tool "${toolName}" code_content contains path traversal`,
      toolName,
      toolType: 'sandbox',
    });
  }
  // Block absolute paths (Unix and Windows)
  if (/^\/|^[A-Za-z]:[\\\/]/.test(codeContent)) {
    throw new ToolExecutionError({
      code: 'TOOL_EXECUTION_ERROR',
      message: `Sandbox tool "${toolName}" code_content must be a relative path`,
      toolName,
      toolType: 'sandbox',
    });
  }
}

/**
 * Interface for running code in isolated sandboxes.
 * Platform provides the implementation (V8 isolates, Docker, etc.)
 */
export interface SandboxRunner {
  /**
   * Execute code in an isolated sandbox.
   */
  run(config: {
    functionName: string;
    runtime: 'javascript' | 'python';
    codeContent: string;
    params: unknown;
    limits: { timeoutMs: number; memoryMb: number };
    /** Global objects injected into the sandbox environment (e.g. memory API) */
    globals?: Record<string, unknown>;
  }): Promise<unknown>;
}

export class SandboxToolExecutor {
  private sandboxTools: Map<string, ToolDefinition>;
  private runner: SandboxRunner;
  private sessionContext?: { sessionId?: string; tenantId?: string; userId?: string };
  private secrets?: SecretsProvider;
  /** Optional feature gate — if provided, blocks execution when it returns false */
  private featureChecker?: () => Promise<boolean>;
  /** Imperative memory API injected into all sandbox/lambda tool executions */
  memoryAPI?: ToolMemoryAPI;

  constructor(config: {
    tools: ToolDefinition[];
    runner: SandboxRunner;
    sessionContext?: { sessionId?: string; tenantId?: string; userId?: string };
    secrets?: SecretsProvider;
    featureChecker?: () => Promise<boolean>;
  }) {
    this.runner = config.runner;
    this.sessionContext = config.sessionContext;
    this.secrets = config.secrets;
    this.featureChecker = config.featureChecker;
    this.sandboxTools = new Map();
    for (const tool of config.tools) {
      if (tool.tool_type === 'sandbox' && tool.sandbox_binding) {
        this.sandboxTools.set(tool.name, tool);
      }
    }
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    // Fail-closed feature gate — if checker provided and returns false, block execution
    if (this.featureChecker) {
      let enabled = false;
      try {
        enabled = await this.featureChecker();
      } catch {
        // Fail closed — treat errors as disabled
        enabled = false;
      }
      if (!enabled) {
        throw new ToolExecutionError({
          code: 'TOOL_CODE_EXECUTION_DISABLED',
          message: 'Code tool execution is disabled for this workspace',
          toolName,
          toolType: 'sandbox',
        });
      }
    }

    const tool = this.sandboxTools.get(toolName);
    if (!tool?.sandbox_binding) {
      throw new ToolExecutionError({
        code: 'TOOL_NOT_FOUND',
        message: `Sandbox tool not found: ${toolName}`,
        toolName,
        toolType: 'sandbox',
      });
    }

    const binding = await resolveSandboxBindingRuntimeNumericFields(
      toolName,
      tool.sandbox_binding,
      this.secrets,
    );

    // Validate code_content for path traversal attacks
    validateCodeContent(toolName, binding.code_content);

    const start = Date.now();

    try {
      const limits = {
        timeoutMs: binding.timeout_ms ?? timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
        memoryMb: binding.memory_mb ?? 128,
      };

      log.debug('Sandbox tool execute', {
        tool: toolName,
        runtime: binding.runtime,
      });

      // Build globals injected into sandbox environment
      const globals: Record<string, unknown> = {};
      if (this.memoryAPI) globals.memory = this.memoryAPI;
      if (this.secrets) {
        globals.secrets = {
          get: (key: string) => this.secrets!.getSecret(key, { toolName }),
        };
        if (this.secrets.getEnvVar) {
          const getEnvVar = this.secrets.getEnvVar.bind(this.secrets);
          globals.env = new Proxy(
            { get: (key: string) => getEnvVar(key) },
            {
              get(target, prop) {
                if (prop === 'get') return target.get;
                if (typeof prop === 'string') return getEnvVar(prop);
                return undefined;
              },
            },
          );
        }
      }

      // Strip _context and _session from params — sandbox tools use the imperative memory API
      // and session globals instead
      const { _context, _session, ...cleanParams } = params;

      // Inject session metadata as a read-only global for sandbox code to access
      if (_session && typeof _session === 'object') {
        globals.session = Object.freeze({ ..._session });
      }

      const result = await this.runner.run({
        functionName: toolName,
        runtime: binding.runtime,
        codeContent: binding.code_content,
        params: cleanParams,
        limits,
        globals: Object.keys(globals).length > 0 ? globals : undefined,
      });

      const latencyMs = Date.now() - start;

      // Mandatory audit trail for sandbox executions
      log.info('sandbox.execution', {
        event: 'sandbox_tool_call',
        toolName,
        runtime: binding.runtime,
        limits,
        success: true,
        latencyMs,
        tenantId: this.sessionContext?.tenantId,
        sessionId: this.sessionContext?.sessionId,
        userId: this.sessionContext?.userId,
        timestamp: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const latencyMs = Date.now() - start;

      // Mandatory audit trail for failures
      log.info('sandbox.execution', {
        event: 'sandbox_tool_call',
        toolName,
        runtime: binding.runtime,
        limits: {
          timeoutMs: binding.timeout_ms ?? timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
          memoryMb: binding.memory_mb ?? 128,
        },
        success: false,
        latencyMs,
        error: msg.split('\n')[0].substring(0, 500),
        tenantId: this.sessionContext?.tenantId,
        sessionId: this.sessionContext?.sessionId,
        userId: this.sessionContext?.userId,
        timestamp: new Date().toISOString(),
      });

      log.error('Sandbox tool execution failed', {
        tool: toolName,
        runtime: binding.runtime,
        error: msg,
      });

      // Preserve ToolExecutionError if already classified
      if (error instanceof ToolExecutionError) throw error;

      // Classify error
      const isTimeout =
        msg.includes('timed out') || msg.includes('timeout') || msg.includes('ETIMEDOUT');
      throw new ToolExecutionError({
        code: isTimeout ? 'TOOL_TIMEOUT' : 'TOOL_SANDBOX_ERROR',
        message: msg.substring(0, 500),
        toolName,
        toolType: 'sandbox',
        retryable: false,
        durationMs: latencyMs,
        cause: error,
      });
    }
  }
}
