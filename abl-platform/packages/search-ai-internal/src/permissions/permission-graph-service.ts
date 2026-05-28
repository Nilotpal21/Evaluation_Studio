/**
 * Permission Graph Service
 *
 * High-level service wrapper for PermissionGraphClient with:
 * - Singleton instance management
 * - Automatic retry logic for transient failures
 * - Circuit breaker pattern for fault tolerance
 * - Monitoring and metrics collection
 * - Health checks and status reporting
 * - Graceful degradation on failures
 *
 * @see permission-graph-client.ts for low-level client
 */

import { PermissionGraphClient } from './permission-graph-client.js';
import type {
  Neo4jConnectionConfig,
  UserNode,
  GroupNode,
  DocumentNode,
  DomainNode,
  CreateUserInput,
  CreateGroupInput,
  CreateDocumentInput,
  CreateDomainInput,
  SetMembershipInput,
  SetPermissionInput,
  FlattenedPermissions,
  PermissionGraphStats,
  PermissionQueryOptions,
} from './types.js';

// ============================================================================
// Service Configuration
// ============================================================================

export interface PermissionGraphServiceConfig extends Neo4jConnectionConfig {
  // Retry configuration
  maxRetries?: number; // Default: 3
  retryDelayMs?: number; // Default: 1000ms
  retryBackoffMultiplier?: number; // Default: 2

  // Circuit breaker configuration
  circuitBreakerThreshold?: number; // Failures before open (default: 5)
  circuitBreakerTimeout?: number; // Reset timeout in ms (default: 60000)

  // Monitoring
  enableMetrics?: boolean; // Default: true
  metricsPrefix?: string; // Default: 'neo4j_permission'
}

// ============================================================================
// Circuit Breaker States
// ============================================================================

enum CircuitState {
  CLOSED = 'closed', // Normal operation
  OPEN = 'open', // Failing, reject requests
  HALF_OPEN = 'half_open', // Testing if recovered
}

// ============================================================================
// Metrics Types
// ============================================================================

interface OperationMetrics {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  retriedCalls: number;
  totalLatencyMs: number;
  lastError?: Error;
  lastErrorAt?: Date;
}

interface ServiceMetrics {
  operations: Map<string, OperationMetrics>;
  circuitState: CircuitState;
  circuitOpenedAt?: Date;
  connectionPoolActive: number;
  connectionPoolIdle: number;
}

// ============================================================================
// Permission Graph Service
// ============================================================================

export class PermissionGraphService {
  private static instance: PermissionGraphService | null = null;
  private client: PermissionGraphClient;
  private config: PermissionGraphServiceConfig;

  // Circuit breaker state
  private circuitState: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private circuitOpenedAt?: Date;
  private lastSuccessAt?: Date;
  private probeInProgress = false;

  // Metrics
  private metrics: ServiceMetrics = {
    operations: new Map(),
    circuitState: CircuitState.CLOSED,
    connectionPoolActive: 0,
    connectionPoolIdle: 0,
  };

  private constructor(config: PermissionGraphServiceConfig) {
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      retryBackoffMultiplier: 2,
      circuitBreakerThreshold: 5,
      circuitBreakerTimeout: 60000,
      enableMetrics: true,
      metricsPrefix: 'neo4j_permission',
      ...config,
    };

    this.client = new PermissionGraphClient(config);
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: PermissionGraphServiceConfig): PermissionGraphService {
    if (!PermissionGraphService.instance) {
      if (!config) {
        throw new Error('PermissionGraphService: config required for first initialization');
      }
      PermissionGraphService.instance = new PermissionGraphService(config);
    }
    return PermissionGraphService.instance;
  }

  /**
   * Reset singleton (for testing)
   */
  static resetInstance(): void {
    if (PermissionGraphService.instance) {
      PermissionGraphService.instance.client.close().catch(console.error);
      PermissionGraphService.instance = null;
    }
  }

  /**
   * Close connection and cleanup
   */
  async close(): Promise<void> {
    await this.client.close();
    PermissionGraphService.instance = null;
  }

  // ==========================================================================
  // Health Checks
  // ==========================================================================

  /**
   * Check service health
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    status: string;
    details: {
      connected: boolean;
      circuitState: CircuitState;
      failureCount: number;
      lastSuccessAt?: Date;
      lastErrorAt?: Date;
    };
  }> {
    try {
      const connected = await this.client.verifyConnection();

      return {
        healthy: connected && this.circuitState !== CircuitState.OPEN,
        status:
          this.circuitState === CircuitState.OPEN
            ? 'circuit_open'
            : connected
              ? 'healthy'
              : 'disconnected',
        details: {
          connected,
          circuitState: this.circuitState,
          failureCount: this.failureCount,
          lastSuccessAt: this.lastSuccessAt,
          lastErrorAt: this.metrics.operations.get('healthCheck')?.lastErrorAt,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        status: 'error',
        details: {
          connected: false,
          circuitState: this.circuitState,
          failureCount: this.failureCount,
          lastSuccessAt: this.lastSuccessAt,
          lastErrorAt: new Date(),
        },
      };
    }
  }

  /**
   * Get service metrics
   */
  getMetrics(): ServiceMetrics {
    return {
      ...this.metrics,
      circuitState: this.circuitState,
      circuitOpenedAt: this.circuitOpenedAt,
    };
  }

  /**
   * Reset metrics (for testing)
   */
  resetMetrics(): void {
    this.metrics.operations.clear();
    this.failureCount = 0;
    this.circuitState = CircuitState.CLOSED;
    this.circuitOpenedAt = undefined;
    this.probeInProgress = false;
  }

  // ==========================================================================
  // Circuit Breaker Logic
  // ==========================================================================

  /**
   * Check if circuit breaker allows operation
   */
  private canExecute(): boolean {
    if (this.circuitState === CircuitState.CLOSED) {
      return true;
    }

    if (this.circuitState === CircuitState.OPEN) {
      const now = Date.now();
      const openedAt = this.circuitOpenedAt?.getTime() || 0;
      const timeout = this.config.circuitBreakerTimeout || 60000;

      if (now - openedAt > timeout) {
        // Timeout expired, try half-open
        this.circuitState = CircuitState.HALF_OPEN;
        this.probeInProgress = true;
        console.log('[PermissionGraphService] Circuit breaker: OPEN → HALF_OPEN');
        return true;
      }

      return false; // Still open
    }

    // HALF_OPEN: only allow one probe request through
    if (this.probeInProgress) {
      return false;
    }
    this.probeInProgress = true;
    return true;
  }

  /**
   * Record operation success
   */
  private recordSuccess(): void {
    this.probeInProgress = false;
    this.lastSuccessAt = new Date();
    this.failureCount = 0;

    if (this.circuitState === CircuitState.HALF_OPEN) {
      this.circuitState = CircuitState.CLOSED;
      console.log('[PermissionGraphService] Circuit breaker: HALF_OPEN → CLOSED');
    }
  }

  /**
   * Record operation failure
   */
  private recordFailure(error: Error): void {
    this.probeInProgress = false;
    this.failureCount++;

    const threshold = this.config.circuitBreakerThreshold || 5;

    if (this.circuitState === CircuitState.HALF_OPEN) {
      // Failed during test, back to open
      this.circuitState = CircuitState.OPEN;
      this.circuitOpenedAt = new Date();
      console.error('[PermissionGraphService] Circuit breaker: HALF_OPEN → OPEN', error);
    } else if (this.circuitState === CircuitState.CLOSED && this.failureCount >= threshold) {
      // Exceeded threshold, open circuit
      this.circuitState = CircuitState.OPEN;
      this.circuitOpenedAt = new Date();
      console.error('[PermissionGraphService] Circuit breaker: CLOSED → OPEN', error);
    }
  }

  // ==========================================================================
  // Retry Logic with Exponential Backoff
  // ==========================================================================

  /**
   * Execute operation with retry logic
   */
  private async executeWithRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
    options?: { skipRetry?: boolean },
  ): Promise<T> {
    // Check circuit breaker
    if (!this.canExecute()) {
      const error = new Error(
        `Circuit breaker is OPEN for ${operationName}. Service temporarily unavailable.`,
      );
      this.updateMetrics(operationName, false, 0, error);
      throw error;
    }

    const startTime = Date.now();
    const maxRetries = options?.skipRetry ? 0 : this.config.maxRetries || 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();

        // Success
        const latency = Date.now() - startTime;
        this.updateMetrics(operationName, true, latency);
        this.recordSuccess();

        if (attempt > 0) {
          console.log(
            `[PermissionGraphService] ${operationName} succeeded after ${attempt} retries`,
          );
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        // Check if error is retryable
        const isRetryable = this.isRetryableError(error as Error);

        if (!isRetryable || attempt >= maxRetries) {
          // Not retryable or exhausted retries
          const latency = Date.now() - startTime;
          this.updateMetrics(operationName, false, latency, lastError);
          this.recordFailure(lastError);
          throw lastError;
        }

        // Calculate backoff delay
        const baseDelay = this.config.retryDelayMs || 1000;
        const multiplier = this.config.retryBackoffMultiplier || 2;
        const delay = baseDelay * Math.pow(multiplier, attempt);

        console.warn(
          `[PermissionGraphService] ${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`,
          error,
        );

        await this.sleep(delay);
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError || new Error('Operation failed');
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();

    // Neo4j transient errors
    if (message.includes('transient')) return true;
    if (message.includes('timeout')) return true;
    if (message.includes('connection')) return true;
    if (message.includes('unavailable')) return true;

    // Network errors
    if (message.includes('econnrefused')) return true;
    if (message.includes('enotfound')) return true;
    if (message.includes('etimedout')) return true;

    return false;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Metrics Tracking
  // ==========================================================================

  /**
   * Update operation metrics
   */
  private updateMetrics(
    operationName: string,
    success: boolean,
    latencyMs: number,
    error?: Error,
  ): void {
    if (!this.config.enableMetrics) return;

    let opMetrics = this.metrics.operations.get(operationName);
    if (!opMetrics) {
      opMetrics = {
        totalCalls: 0,
        successCalls: 0,
        failedCalls: 0,
        retriedCalls: 0,
        totalLatencyMs: 0,
      };
      this.metrics.operations.set(operationName, opMetrics);
    }

    opMetrics.totalCalls++;
    opMetrics.totalLatencyMs += latencyMs;

    if (success) {
      opMetrics.successCalls++;
    } else {
      opMetrics.failedCalls++;
      opMetrics.lastError = error;
      opMetrics.lastErrorAt = new Date();
    }
  }

  // ==========================================================================
  // Schema Management
  // ==========================================================================

  async initializeSchema(): Promise<void> {
    return this.executeWithRetry('initializeSchema', () => this.client.initializeSchema());
  }

  // ==========================================================================
  // User Operations
  // ==========================================================================

  async upsertUser(input: CreateUserInput): Promise<UserNode> {
    return this.executeWithRetry('upsertUser', () => this.client.upsertUser(input));
  }

  async getUser(tenantId: string, email: string): Promise<UserNode | null> {
    return this.executeWithRetry('getUser', () => this.client.getUser(tenantId, email));
  }

  async batchUpsertUsers(tenantId: string, users: CreateUserInput[]): Promise<number> {
    return this.executeWithRetry('batchUpsertUsers', () =>
      this.client.batchUpsertUsers(tenantId, users),
    );
  }

  // ==========================================================================
  // Group Operations
  // ==========================================================================

  async upsertGroup(input: CreateGroupInput): Promise<GroupNode> {
    return this.executeWithRetry('upsertGroup', () => this.client.upsertGroup(input));
  }

  async getGroup(tenantId: string, groupId: string): Promise<GroupNode | null> {
    return this.executeWithRetry('getGroup', () => this.client.getGroup(tenantId, groupId));
  }

  async batchUpsertGroups(tenantId: string, groups: CreateGroupInput[]): Promise<number> {
    return this.executeWithRetry('batchUpsertGroups', () =>
      this.client.batchUpsertGroups(tenantId, groups),
    );
  }

  // ==========================================================================
  // Document Operations
  // ==========================================================================

  async upsertDocument(input: CreateDocumentInput): Promise<DocumentNode> {
    return this.executeWithRetry('upsertDocument', () => this.client.upsertDocument(input));
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<boolean> {
    return this.executeWithRetry('deleteDocument', () =>
      this.client.deleteDocument(tenantId, documentId),
    );
  }

  // ==========================================================================
  // Domain Operations
  // ==========================================================================

  async upsertDomain(input: CreateDomainInput): Promise<DomainNode> {
    return this.executeWithRetry('upsertDomain', () => this.client.upsertDomain(input));
  }

  // ==========================================================================
  // Membership Operations
  // ==========================================================================

  async setMembership(input: SetMembershipInput): Promise<void> {
    return this.executeWithRetry('setMembership', () => this.client.setMembership(input));
  }

  async removeMembership(input: SetMembershipInput): Promise<void> {
    return this.executeWithRetry('removeMembership', () => this.client.removeMembership(input));
  }

  // ==========================================================================
  // Permission Operations
  // ==========================================================================

  async setPermission(input: SetPermissionInput): Promise<void> {
    return this.executeWithRetry('setPermission', () => this.client.setPermission(input));
  }

  async removePermission(input: SetPermissionInput): Promise<void> {
    return this.executeWithRetry('removePermission', () => this.client.removePermission(input));
  }

  async removeAllDocumentPermissions(tenantId: string, documentId: string): Promise<number> {
    return this.executeWithRetry('removeAllDocumentPermissions', () =>
      this.client.removeAllDocumentPermissions(tenantId, documentId),
    );
  }

  async setPublicInDomain(tenantId: string, documentId: string, domain: string): Promise<void> {
    return this.executeWithRetry('setPublicInDomain', () =>
      this.client.setPublicInDomain(tenantId, documentId, domain),
    );
  }

  // ==========================================================================
  // Permission Queries
  // ==========================================================================

  async getUserGroups(tenantId: string, email: string, maxDepth?: number): Promise<string[]> {
    return this.executeWithRetry('getUserGroups', () =>
      this.client.getUserGroups(tenantId, email, maxDepth),
    );
  }

  async getAccessibleDocuments(
    tenantId: string,
    email: string,
    options?: PermissionQueryOptions,
  ): Promise<string[]> {
    return this.executeWithRetry('getAccessibleDocuments', () =>
      this.client.getAccessibleDocuments(tenantId, email, options),
    );
  }

  async getFlattenedPermissions(
    tenantId: string,
    documentId: string,
  ): Promise<FlattenedPermissions> {
    return this.executeWithRetry('getFlattenedPermissions', () =>
      this.client.getFlattenedPermissions(tenantId, documentId),
    );
  }

  async getGraphStats(tenantId: string): Promise<PermissionGraphStats> {
    return this.executeWithRetry('getGraphStats', () => this.client.getGraphStats(tenantId));
  }
}
