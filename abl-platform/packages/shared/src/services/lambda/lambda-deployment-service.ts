/**
 * Lambda Deployment Service
 *
 * Manages per-tenant Lambda runner function lifecycle:
 * deploy, poll-active, health-check, and teardown.
 *
 * Each tenant+runtime pair gets its own Lambda function so that
 * custom-code tool execution is fully isolated (Principle 1 — Tenant Isolation).
 */

import {
  LambdaClient,
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  InvokeCommand,
  Runtime,
} from '@aws-sdk/client-lambda';
import type { LambdaLogger } from './types.js';
import type { LambdaDeploymentStore, LambdaDeploymentRecord } from './lambda-deployment-store.js';
import type { LambdaHandlerTemplates } from './lambda-code-packager.js';

/* v8 ignore start -- default logger fallback used only when no logger injected */
const defaultLogger: LambdaLogger = {
  info: (msg, meta) => console.info(msg, meta),
  warn: (msg, meta) => console.warn(msg, meta),
  error: (msg, meta) => console.error(msg, meta),
  debug: (msg, meta) => console.debug(msg, meta),
};
/* v8 ignore stop */

// ─── Constants ──────────────────────────────────────────────────────────────

/** Lambda function name max length. */
const LAMBDA_NAME_MAX_LENGTH = 64;

/** Prefix for all runner functions — makes IAM policy scoping easy. */
const FUNCTION_NAME_PREFIX = 'abl-runner';

/** Interval between GetFunction polls when waiting for Active state. */
const POLL_INTERVAL_MS = 2_000;

/** Default deploy timeout if none supplied via config. */
const DEFAULT_DEPLOY_TIMEOUT_MS = 60_000;

/** Runtime string suffix map. */
const RUNTIME_SUFFIX: Record<string, string> = {
  javascript: 'js',
  python: 'py',
};

/** AWS Lambda runtime identifiers. */
const AWS_RUNTIME: Record<string, Runtime> = {
  javascript: Runtime.nodejs20x,
  python: Runtime.python312,
};

/** Handler entry points per runtime. */
const HANDLER_ENTRY: Record<string, string> = {
  javascript: 'index.handler',
  python: 'handler.handler',
};

// ─── Config ─────────────────────────────────────────────────────────────────

export interface LambdaDeploymentServiceConfig {
  store: LambdaDeploymentStore;
  region: string;
  roleArn: string;
  memoryMb: number;
  timeoutSec: number;
  nodeLayerArn?: string;
  pythonLayerArn?: string;
  deployTimeoutMs?: number;
  logger?: LambdaLogger;
  /** Handler templates for Lambda code packaging. Required for deploy operations. */
  handlerTemplates?: LambdaHandlerTemplates;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class LambdaDeploymentService {
  private readonly store: LambdaDeploymentStore;
  private readonly client: LambdaClient;
  private readonly region: string;
  private readonly roleArn: string;
  private readonly memoryMb: number;
  private readonly timeoutSec: number;
  private readonly nodeLayerArn?: string;
  private readonly pythonLayerArn?: string;
  private readonly deployTimeoutMs: number;
  private readonly log: LambdaLogger;
  private readonly handlerTemplates?: LambdaHandlerTemplates;

  constructor(config: LambdaDeploymentServiceConfig) {
    this.store = config.store;
    this.region = config.region;
    this.roleArn = config.roleArn;
    this.memoryMb = config.memoryMb;
    this.timeoutSec = config.timeoutSec;
    this.nodeLayerArn = config.nodeLayerArn;
    this.pythonLayerArn = config.pythonLayerArn;
    this.deployTimeoutMs = config.deployTimeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS;
    this.log = config.logger ?? defaultLogger;
    this.handlerTemplates = config.handlerTemplates;
    this.client = new LambdaClient({ region: this.region });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Ensure a Lambda runner is deployed for the given tenant + runtime.
   * If an active deployment already exists, this is a no-op.
   * If the record is missing, failed, or stale-deploying, triggers a fresh deploy.
   */
  async ensureRunnerDeployed(tenantId: string, runtime: 'javascript' | 'python'): Promise<void> {
    const existing = await this.store.get(tenantId, runtime);

    if (existing?.status === 'active') {
      this.log.debug('Runner already active, skipping deploy', { tenantId, runtime });
      return;
    }

    // Not found, failed, or stuck deploying — (re)deploy
    this.log.info('Deploying Lambda runner', {
      tenantId,
      runtime,
      previousStatus: existing?.status ?? 'none',
    });

    await this._deployRunner(tenantId, runtime);
  }

  /**
   * Invoke the runner with a `{ ping: true }` payload.
   * Returns `true` if the function responds successfully, `false` otherwise.
   */
  async checkHealth(tenantId: string, runtime: 'javascript' | 'python'): Promise<boolean> {
    const record = await this.store.get(tenantId, runtime);
    if (!record || record.status !== 'active') {
      return false;
    }

    try {
      const response = await this.client.send(
        new InvokeCommand({
          FunctionName: record.functionName,
          Payload: Buffer.from(JSON.stringify({ ping: true })),
          InvocationType: 'RequestResponse',
        }),
      );

      const healthy = response.StatusCode === 200 && !response.FunctionError;
      if (healthy) {
        await this.store.updateStatus(tenantId, runtime, 'active', {
          lastHealthCheck: new Date().toISOString(),
        });
      }
      return healthy;
    } catch (err) {
      this.log.warn('Health check failed', {
        tenantId,
        runtime,
        functionName: record.functionName,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * Delete the Lambda function and remove the store record.
   * No-op if no deployment record exists.
   */
  async deleteRunner(tenantId: string, runtime: 'javascript' | 'python'): Promise<void> {
    const record = await this.store.get(tenantId, runtime);
    if (!record) {
      this.log.debug('No deployment record to delete', { tenantId, runtime });
      return;
    }

    await this.store.updateStatus(tenantId, runtime, 'deleting');

    try {
      await this.client.send(
        new DeleteFunctionCommand({
          FunctionName: record.functionName,
        }),
      );
    } catch (err) {
      // ResourceNotFoundException means already gone — that's fine
      const code = (err as any)?.name ?? '';
      if (code !== 'ResourceNotFoundException') {
        this.log.error('Failed to delete Lambda function', {
          tenantId,
          runtime,
          functionName: record.functionName,
          error: String(err),
        });
        throw err;
      }
    }

    await this.store.delete(tenantId, runtime);
    this.log.info('Runner deleted', { tenantId, runtime, functionName: record.functionName });
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Full deploy cycle: package code, create Lambda, poll until Active,
   * and persist the deployment record.
   */
  /* internal, but not truly private so tests can spy */
  /* v8 ignore start -- _deployRunner requires AWS Lambda SDK + code packager (integration tested) */
  async _deployRunner(tenantId: string, runtime: 'javascript' | 'python'): Promise<void> {
    const functionName = this._buildFunctionName(tenantId, runtime);
    const now = new Date().toISOString();

    // 1. Mark as deploying
    await this.store.upsert({
      tenantId,
      runtime,
      functionName,
      status: 'deploying',
      region: this.region,
      createdAt: now,
      updatedAt: now,
    });

    try {
      // 2. Build ZIP package
      if (!this.handlerTemplates) {
        throw new Error('handlerTemplates must be provided in config for deploy operations');
      }
      const { LambdaCodePackager } = await import('./lambda-code-packager.js');
      const packager = new LambdaCodePackager(this.handlerTemplates);
      const zipBuffer = await packager.createRunnerPackage(runtime);

      // 3. Resolve layers
      const layers = this._resolveLayers(runtime);

      // 4. Create Lambda function
      await this.client.send(
        new CreateFunctionCommand({
          FunctionName: functionName,
          Runtime: AWS_RUNTIME[runtime],
          Handler: HANDLER_ENTRY[runtime],
          Role: this.roleArn,
          Code: { ZipFile: zipBuffer },
          MemorySize: this.memoryMb,
          Timeout: this.timeoutSec,
          Layers: layers.length > 0 ? layers : undefined,
          Environment: {
            Variables: {
              TENANT_ID: tenantId,
              RUNNER_RUNTIME: runtime,
            },
          },
          Tags: {
            'abl:tenant': tenantId,
            'abl:runtime': runtime,
            'abl:managed-by': 'abl-platform',
          },
        }),
      );

      // 5. Poll until active
      await this._pollFunctionActive(functionName);

      // 6. Mark active
      await this.store.updateStatus(tenantId, runtime, 'active', {
        updatedAt: new Date().toISOString(),
      });

      this.log.info('Runner deployed successfully', { tenantId, runtime, functionName });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.error('Runner deployment failed', {
        tenantId,
        runtime,
        functionName,
        error: reason,
      });

      await this.store.updateStatus(tenantId, runtime, 'failed', {
        failureReason: reason,
        updatedAt: new Date().toISOString(),
      });

      throw err;
    }
  }
  /* v8 ignore stop */

  /**
   * Poll GetFunction until Configuration.State === 'Active' or timeout.
   */
  async _pollFunctionActive(functionName: string): Promise<void> {
    const deadline = Date.now() + this.deployTimeoutMs;

    while (Date.now() < deadline) {
      const response = await this.client.send(
        new GetFunctionCommand({ FunctionName: functionName }),
      );

      const state = response.Configuration?.State;
      if (state === 'Active') {
        return;
      }

      if (state === 'Failed') {
        const reason = response.Configuration?.StateReason ?? 'Unknown';
        throw new Error(`Lambda function "${functionName}" entered Failed state: ${reason}`);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(
      `Timed out waiting for Lambda function "${functionName}" to become Active ` +
        `(timeout: ${this.deployTimeoutMs}ms)`,
    );
  }

  /**
   * Build a deterministic, sanitized function name.
   *
   * Format: `abl-runner-{sanitizedTenantId}-{js|py}`
   * Truncated to 64 chars (Lambda limit).
   */
  _buildFunctionName(tenantId: string, runtime: string): string {
    const suffix = RUNTIME_SUFFIX[runtime] ?? runtime.slice(0, 2);
    const prefix = FUNCTION_NAME_PREFIX + '-';
    const postfix = '-' + suffix;

    // Sanitize: keep only alphanumeric, hyphen, underscore
    const sanitized = tenantId.replace(/[^a-zA-Z0-9\-_]/g, '_');

    // Available space for the tenant portion
    const maxTenantLen = LAMBDA_NAME_MAX_LENGTH - prefix.length - postfix.length;
    const truncated = sanitized.slice(0, maxTenantLen);

    return `${prefix}${truncated}${postfix}`;
  }

  /**
   * Resolve Lambda layer ARNs for the given runtime.
   */
  private _resolveLayers(runtime: string): string[] {
    const layers: string[] = [];
    if (runtime === 'javascript' && this.nodeLayerArn) {
      layers.push(this.nodeLayerArn);
    }
    if (runtime === 'python' && this.pythonLayerArn) {
      layers.push(this.pythonLayerArn);
    }
    return layers;
  }
}
