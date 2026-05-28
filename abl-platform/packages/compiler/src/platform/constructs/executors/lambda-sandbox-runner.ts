/**
 * Lambda Sandbox Runner
 *
 * Implements SandboxRunner by invoking per-tenant AWS Lambda functions.
 * Strict read-only execution contract: the runtime NEVER deploys, redeploys,
 * or self-heals. It only reads deployment state and invokes active functions.
 *
 * Key behaviors:
 * - tenantId is REQUIRED (from session context)
 * - Deployment MUST exist and be 'active' in the store
 * - Stale health checks trigger a ping before invocation
 * - JS params get $-prefixed (same convention as GvisorSandboxRunner)
 * - JWT auth token injected for Lambda memory API access
 *
 * SECURITY:
 * - Tenant isolation via deployment store lookup
 * - Code size validation (1MB max)
 * - JWT-scoped memory API access
 * - Dangerous module blocking in Lambda context
 */

import type { LambdaClient } from '@aws-sdk/client-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import type { SandboxRunner } from './sandbox-tool-executor.js';
import type { GvisorSessionContext, JwtSigner } from './gvisor-sandbox-runner.js';
import { ToolExecutionError } from '@agent-platform/shared';
import { createLogger } from '../../logger.js';

const log = createLogger('lambda-sandbox-runner');

// ─── Constants ────────────────────────────────────────────────────────────

const MAX_CODE_SIZE = 1024 * 1024; // 1MB
const DEFAULT_HEALTH_TTL_MS = 300_000; // 5 minutes

// ─── Config ───────────────────────────────────────────────────────────────

export interface LambdaSandboxConfig {
  /** AWS region for Lambda invocations */
  region: string;
  /** Memory API base URL for MemoryManager in Lambda */
  memoryApiBaseUrl: string;
  /** Health check TTL in ms (default 300000 = 5 min) */
  healthTtlMs: number;
}

// ─── Deployment Store Types ───────────────────────────────────────────────
// Compiler-local copies — the runtime app has its own identical definitions.
// The compiler package cannot import from the runtime app, so we define
// compatible types here.

export type LambdaDeploymentStatus = 'deploying' | 'active' | 'failed' | 'deleting';

export interface LambdaDeploymentRecord {
  tenantId: string;
  runtime: 'javascript' | 'python';
  functionName: string;
  status: LambdaDeploymentStatus;
  region: string;
  createdAt: string;
  updatedAt: string;
  lastHealthCheck?: string;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

export interface LambdaDeploymentStore {
  get(tenantId: string, runtime: string): Promise<LambdaDeploymentRecord | null>;
  upsert(record: LambdaDeploymentRecord): Promise<void>;
  updateStatus(
    tenantId: string,
    runtime: string,
    status: LambdaDeploymentStatus,
    extra?: Partial<LambdaDeploymentRecord>,
  ): Promise<void>;
  delete(tenantId: string, runtime: string): Promise<void>;
  listByTenant(tenantId: string): Promise<LambdaDeploymentRecord[]>;
}

// ─── Param Preprocessing ──────────────────────────────────────────────────

/**
 * Preprocess tool params for Lambda invocation.
 * JavaScript runtime: $-prefix all keys, filter system params (e.g., 'thought').
 * Python runtime: passthrough (no preprocessing).
 */
function preprocessParams(params: unknown, runtime: string): unknown {
  if (runtime !== 'javascript' || !params || typeof params !== 'object') {
    return params;
  }
  const input = params as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'thought') continue; // Filter system params
    result[`$${key}`] = value;
  }
  return result;
}

// ─── Runner ───────────────────────────────────────────────────────────────

export class LambdaSandboxRunner implements SandboxRunner {
  private healthTtlMs: number;

  constructor(
    private config: LambdaSandboxConfig,
    private deploymentStore: LambdaDeploymentStore,
    private lambdaClient: LambdaClient,
    private sessionContext?: GvisorSessionContext,
    private jwtSigner?: JwtSigner,
  ) {
    this.healthTtlMs = config.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS;
  }

  // ─── SandboxRunner.run ────────────────────────────────────────────────

  async run(config: {
    functionName: string;
    runtime: 'javascript' | 'python';
    codeContent: string;
    params: unknown;
    limits: { timeoutMs: number; memoryMb: number };
  }): Promise<unknown> {
    // 1. tenantId is required
    const tenantId = this.sessionContext?.tenantId;
    if (!tenantId) {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_ERROR',
        message: 'Lambda sandbox requires tenantId in session context',
        toolName: config.functionName,
        toolType: 'sandbox',
        retryable: false,
      });
    }

    // 2. Validate code content (presence, size)
    if (!config.codeContent) {
      throw new ToolExecutionError({
        code: 'TOOL_NOT_FOUND',
        message: `Sandbox tool "${config.functionName}" has no code content`,
        toolName: config.functionName,
        toolType: 'sandbox',
      });
    }
    if (config.codeContent.length > MAX_CODE_SIZE) {
      throw new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: `Sandbox tool "${config.functionName}" code exceeds size limit (${config.codeContent.length} bytes, max ${MAX_CODE_SIZE})`,
        toolName: config.functionName,
        toolType: 'sandbox',
      });
    }

    // 3. Strict lookup — deployment MUST exist and be active
    const deployment = await this.deploymentStore.get(tenantId, config.runtime);

    if (!deployment) {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_NOT_DEPLOYED',
        message: `Lambda runner not deployed for tenant "${tenantId}" runtime "${config.runtime}". Deploy via Studio.`,
        toolName: config.functionName,
        toolType: 'sandbox',
        retryable: false,
      });
    }

    if (deployment.status === 'deploying') {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_DEPLOYING',
        message: `Lambda runner for tenant "${tenantId}" is currently deploying. Retry in a few seconds.`,
        toolName: config.functionName,
        toolType: 'sandbox',
        retryable: true,
      });
    }

    if (deployment.status === 'failed') {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_DEPLOY_FAILED',
        message: `Lambda runner deployment failed for tenant "${tenantId}": ${deployment.failureReason || 'unknown'}. Redeploy via Studio.`,
        toolName: config.functionName,
        toolType: 'sandbox',
        retryable: false,
      });
    }

    if (deployment.status !== 'active') {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_ERROR',
        message: `Lambda runner for tenant "${tenantId}" is in unexpected state "${deployment.status}"`,
        toolName: config.functionName,
        toolType: 'sandbox',
        retryable: false,
      });
    }

    // 4. Health check if stale
    if (this.isHealthCheckStale(deployment)) {
      const healthy = await this.healthCheck(deployment);
      if (!healthy) {
        throw new ToolExecutionError({
          code: 'TOOL_SANDBOX_UNHEALTHY',
          message: `Lambda runner "${deployment.functionName}" failed health check. Redeploy via Studio.`,
          toolName: config.functionName,
          toolType: 'sandbox',
          retryable: false,
        });
      }
    }

    // 5. Invoke (only reached if active + healthy)
    return this.invokeLambda(deployment, config);
  }

  // ─── Health Check ─────────────────────────────────────────────────────

  /**
   * Check if the health check timestamp is stale (or missing).
   */
  private isHealthCheckStale(deployment: LambdaDeploymentRecord): boolean {
    if (!deployment.lastHealthCheck) return true;
    const lastCheck = new Date(deployment.lastHealthCheck).getTime();
    return Date.now() - lastCheck > this.healthTtlMs;
  }

  /**
   * Invoke Lambda with a ping payload to verify it is reachable.
   * Updates lastHealthCheck in the store on success.
   * Returns false on any error.
   */
  private async healthCheck(deployment: LambdaDeploymentRecord): Promise<boolean> {
    try {
      const command = new InvokeCommand({
        FunctionName: deployment.functionName,
        Payload: new TextEncoder().encode(JSON.stringify({ ping: true })),
      });

      const response = await this.lambdaClient.send(command);
      if (response.StatusCode === 200) {
        await this.deploymentStore.updateStatus(deployment.tenantId, deployment.runtime, 'active', {
          lastHealthCheck: new Date().toISOString(),
        });
        return true;
      }

      log.warn('Lambda health check returned non-200 status', {
        functionName: deployment.functionName,
        statusCode: response.StatusCode,
      });
      return false;
    } catch (err) {
      log.error('Lambda health check failed', {
        functionName: deployment.functionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ─── Lambda Invocation ────────────────────────────────────────────────

  /**
   * Invoke the Lambda function with the sandbox execution payload.
   * Parses the double-encoded response (outer: Lambda envelope, inner: handler response).
   */
  private async invokeLambda(
    deployment: LambdaDeploymentRecord,
    config: {
      functionName: string;
      runtime: 'javascript' | 'python';
      codeContent: string;
      params: unknown;
      limits: { timeoutMs: number; memoryMb: number };
    },
  ): Promise<unknown> {
    // Preprocess params ($-prefix for JavaScript, passthrough for Python)
    const processedParams = preprocessParams(config.params, config.runtime);

    // Generate JWT for memory API access
    let accessToken: string | undefined;
    if (this.jwtSigner && this.sessionContext) {
      try {
        const claims: Record<string, unknown> = {};
        if (this.sessionContext.sessionId) claims.sessionId = this.sessionContext.sessionId;
        if (this.sessionContext.accountId) claims.accountId = this.sessionContext.accountId;
        if (this.sessionContext.userId) claims.userId = this.sessionContext.userId;
        if (this.sessionContext.appvId) claims.appvId = this.sessionContext.appvId;
        if (this.sessionContext.projectId) claims.projectId = this.sessionContext.projectId;
        if (this.sessionContext.envId) claims.envId = this.sessionContext.envId;
        accessToken = await this.jwtSigner(claims);
      } catch (err) {
        log.error('Failed to generate JWT for Lambda invocation', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Build Lambda invocation payload
    const payload = {
      runtime: config.runtime,
      code: config.codeContent,
      params: processedParams,
      functionName: config.functionName,
      context: {
        accessToken: accessToken || '',
        executionMode: 'execute',
        mockMemoryData: {},
        blockDangerousModules: true,
        memoryApiBaseUrl: this.config.memoryApiBaseUrl,
      },
    };

    const command = new InvokeCommand({
      FunctionName: deployment.functionName,
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    });

    log.debug('Invoking Lambda sandbox', {
      functionName: deployment.functionName,
      toolName: config.functionName,
      runtime: config.runtime,
      codeSize: config.codeContent.length,
    });

    const response = await this.lambdaClient.send(command);

    // Decode response payload (Uint8Array -> string -> JSON)
    if (!response.Payload) {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_ERROR',
        message: `Lambda "${deployment.functionName}" returned no payload`,
        toolName: config.functionName,
        toolType: 'sandbox',
      });
    }

    const rawPayload = new TextDecoder().decode(response.Payload);
    let outerResponse: { statusCode?: number; body?: string };
    try {
      outerResponse = JSON.parse(rawPayload);
    } catch {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_ERROR',
        message: `Lambda "${deployment.functionName}" returned invalid JSON payload`,
        toolName: config.functionName,
        toolType: 'sandbox',
      });
    }

    // Parse inner body (double-encoded: outer statusCode+body, inner response+logs+error)
    if (!outerResponse.body) {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_ERROR',
        message: `Lambda "${deployment.functionName}" returned no body in response`,
        toolName: config.functionName,
        toolType: 'sandbox',
      });
    }

    let innerBody: { response?: unknown; logs?: string[]; error?: string };
    try {
      innerBody = JSON.parse(outerResponse.body);
    } catch {
      throw new ToolExecutionError({
        code: 'TOOL_SANDBOX_ERROR',
        message: `Lambda "${deployment.functionName}" returned invalid JSON body`,
        toolName: config.functionName,
        toolType: 'sandbox',
      });
    }

    // Check for error in inner body
    if (innerBody.error && innerBody.error.startsWith('[Error]')) {
      throw new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: innerBody.error,
        toolName: config.functionName,
        toolType: 'sandbox',
      });
    }

    // Log execution logs if present
    if (innerBody.logs && innerBody.logs.length > 0) {
      log.debug('Lambda execution logs', {
        toolName: config.functionName,
        logCount: innerBody.logs.length,
      });
    }

    return innerBody.response;
  }
}
