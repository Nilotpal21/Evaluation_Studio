/**
 * Permission Graph Service Tests
 *
 * Comprehensive test suite for PermissionGraphService covering:
 * - Singleton pattern
 * - Retry logic with exponential backoff
 * - Circuit breaker state transitions
 * - Metrics collection
 * - Health checks
 * - Error handling
 * - All wrapped operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PermissionGraphService } from '../permission-graph-service.js';
import { PermissionGraphClient } from '../permission-graph-client.js';
import type { PermissionGraphServiceConfig, CreateUserInput, UserNode } from '../types.js';

// Mock PermissionGraphClient — vitest 4.x requires a real class for `new` calls
// (vi.fn().mockImplementation() no longer works as a class constructor)
vi.mock('../permission-graph-client.js', () => {
  class MockPermissionGraphClient {
    close = vi.fn().mockResolvedValue(undefined);
    verifyConnection = vi.fn().mockResolvedValue(true);
    initializeSchema = vi.fn().mockResolvedValue(undefined);
    upsertUser = vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      email: 'test@example.com',
      displayName: 'Test User',
      domain: 'example.com',
      status: 'active',
      createdAt: new Date(),
    });
    getUser = vi.fn().mockResolvedValue(null);
    batchUpsertUsers = vi.fn().mockResolvedValue(10);
    upsertGroup = vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      groupId: 'azuread:group1',
      source: 'azuread',
      createdAt: new Date(),
    });
    getGroup = vi.fn().mockResolvedValue(null);
    batchUpsertGroups = vi.fn().mockResolvedValue(5);
    upsertDocument = vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      documentId: 'doc-1',
      sourceId: 'connector-1',
      source: 'sharepoint',
      publicInDomain: false,
      publicEverywhere: false,
      createdAt: new Date(),
    });
    deleteDocument = vi.fn().mockResolvedValue(true);
    upsertDomain = vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      domain: 'example.com',
      verified: true,
      verificationMethod: 'idp-trust',
      createdAt: new Date(),
    });
    setMembership = vi.fn().mockResolvedValue(undefined);
    removeMembership = vi.fn().mockResolvedValue(undefined);
    setPermission = vi.fn().mockResolvedValue(undefined);
    removePermission = vi.fn().mockResolvedValue(undefined);
    setPublicInDomain = vi.fn().mockResolvedValue(undefined);
    getUserGroups = vi.fn().mockResolvedValue(['group1', 'group2']);
    getAccessibleDocuments = vi.fn().mockResolvedValue(['doc1', 'doc2']);
    getFlattenedPermissions = vi.fn().mockResolvedValue({
      allowedUsers: ['user1@example.com'],
      allowedGroups: ['group1'],
      allowedDomains: ['example.com'],
      publicInDomain: true,
      publicEverywhere: false,
    });
    getGraphStats = vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      userCount: 100,
      groupCount: 10,
      documentCount: 1000,
      domainCount: 2,
      membershipCount: 200,
      permissionCount: 5000,
      averageGroupDepth: 2.5,
      maxGroupDepth: 5,
      lastUpdated: new Date(),
    });
  }
  return { PermissionGraphClient: MockPermissionGraphClient };
});

describe('PermissionGraphService', () => {
  const testConfig: PermissionGraphServiceConfig = {
    uri: 'neo4j://localhost:7687',
    username: 'neo4j',
    password: 'password',
    database: 'neo4j',
    maxRetries: 3,
    retryDelayMs: 100, // Shorter for tests
    retryBackoffMultiplier: 2,
    circuitBreakerThreshold: 3, // Lower for tests
    circuitBreakerTimeout: 1000, // Shorter for tests
    enableMetrics: true,
  };

  beforeEach(() => {
    // Reset singleton before each test
    PermissionGraphService.resetInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup
    PermissionGraphService.resetInstance();
  });

  // ==========================================================================
  // Singleton Pattern Tests
  // ==========================================================================

  describe('Singleton Pattern', () => {
    it('should create instance on first call with config', () => {
      const service = PermissionGraphService.getInstance(testConfig);
      expect(service).toBeInstanceOf(PermissionGraphService);
    });

    it('should return same instance on subsequent calls', () => {
      const service1 = PermissionGraphService.getInstance(testConfig);
      const service2 = PermissionGraphService.getInstance();
      expect(service1).toBe(service2);
    });

    it('should throw error if getInstance called without config first time', () => {
      expect(() => {
        PermissionGraphService.getInstance();
      }).toThrow('PermissionGraphService: config required for first initialization');
    });

    it('should create new instance after resetInstance', () => {
      const service1 = PermissionGraphService.getInstance(testConfig);
      PermissionGraphService.resetInstance();
      const service2 = PermissionGraphService.getInstance(testConfig);
      expect(service1).not.toBe(service2);
    });

    it('should call client.close on resetInstance', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      PermissionGraphService.resetInstance();

      await new Promise((resolve) => setTimeout(resolve, 10)); // Wait for async close
      expect(mockClient.close).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Configuration Tests
  // ==========================================================================

  describe('Configuration', () => {
    it('should apply default configuration values', () => {
      const minimalConfig = {
        uri: 'neo4j://localhost:7687',
        username: 'neo4j',
        password: 'password',
      };

      const service = PermissionGraphService.getInstance(minimalConfig);
      const config = (service as any).config;

      expect(config.maxRetries).toBe(3);
      expect(config.retryDelayMs).toBe(1000);
      expect(config.retryBackoffMultiplier).toBe(2);
      expect(config.circuitBreakerThreshold).toBe(5);
      expect(config.circuitBreakerTimeout).toBe(60000);
      expect(config.enableMetrics).toBe(true);
      expect(config.metricsPrefix).toBe('neo4j_permission');
    });

    it('should override default configuration values', () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const config = (service as any).config;

      expect(config.maxRetries).toBe(3);
      expect(config.retryDelayMs).toBe(100);
      expect(config.circuitBreakerThreshold).toBe(3);
    });
  });

  // ==========================================================================
  // Health Check Tests
  // ==========================================================================

  describe('Health Checks', () => {
    it('should return healthy when connected and circuit closed', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;
      mockClient.verifyConnection.mockResolvedValue(true);

      const health = await service.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.status).toBe('healthy');
      expect(health.details.connected).toBe(true);
      expect(health.details.circuitState).toBe('closed');
    });

    it('should return unhealthy when not connected', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;
      mockClient.verifyConnection.mockResolvedValue(false);

      const health = await service.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.status).toBe('disconnected');
      expect(health.details.connected).toBe(false);
    });

    it('should return unhealthy when circuit is open', async () => {
      const service = PermissionGraphService.getInstance(testConfig);

      // Open circuit by causing failures
      (service as any).circuitState = 'open';
      (service as any).circuitOpenedAt = new Date();

      const health = await service.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.status).toBe('circuit_open');
      expect(health.details.circuitState).toBe('open');
    });

    it('should handle health check errors gracefully', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;
      mockClient.verifyConnection.mockRejectedValue(new Error('Connection failed'));

      const health = await service.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.status).toBe('error');
    });
  });

  // ==========================================================================
  // Metrics Tests
  // ==========================================================================

  describe('Metrics', () => {
    it('should collect metrics for successful operations', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;
      mockClient.upsertUser.mockResolvedValue({ email: 'test@example.com' } as UserNode);

      await service.upsertUser({
        tenantId: 'tenant-1',
        email: 'test@example.com',
      });

      const metrics = service.getMetrics();
      const opMetrics = metrics.operations.get('upsertUser');

      expect(opMetrics).toBeDefined();
      expect(opMetrics!.totalCalls).toBe(1);
      expect(opMetrics!.successCalls).toBe(1);
      expect(opMetrics!.failedCalls).toBe(0);
      expect(opMetrics!.totalLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should collect metrics for failed operations', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;
      const testError = new Error('Operation failed');
      mockClient.upsertUser.mockRejectedValue(testError);

      try {
        await service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        });
      } catch (error) {
        // Expected
      }

      const metrics = service.getMetrics();
      const opMetrics = metrics.operations.get('upsertUser');

      expect(opMetrics).toBeDefined();
      expect(opMetrics!.totalCalls).toBeGreaterThanOrEqual(1); // May include retries
      expect(opMetrics!.failedCalls).toBe(1);
      expect(opMetrics!.lastError).toBe(testError);
      expect(opMetrics!.lastErrorAt).toBeInstanceOf(Date);
    });

    it('should track circuit state in metrics', async () => {
      const service = PermissionGraphService.getInstance(testConfig);

      const metrics1 = service.getMetrics();
      expect(metrics1.circuitState).toBe('closed');

      // Force circuit open
      (service as any).circuitState = 'open';

      const metrics2 = service.getMetrics();
      expect(metrics2.circuitState).toBe('open');
    });

    it('should reset metrics correctly', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;
      mockClient.upsertUser.mockResolvedValue({ email: 'test@example.com' } as UserNode);

      // Generate some metrics
      await service.upsertUser({
        tenantId: 'tenant-1',
        email: 'test@example.com',
      });

      let metrics = service.getMetrics();
      expect(metrics.operations.size).toBeGreaterThan(0);

      // Reset metrics
      service.resetMetrics();

      metrics = service.getMetrics();
      expect(metrics.operations.size).toBe(0);
      expect(metrics.circuitState).toBe('closed');
    });

    it('should not collect metrics when disabled', async () => {
      const configWithoutMetrics = {
        ...testConfig,
        enableMetrics: false,
      };

      PermissionGraphService.resetInstance();
      const service = PermissionGraphService.getInstance(configWithoutMetrics);
      const mockClient = (service as any).client;
      mockClient.upsertUser.mockResolvedValue({ email: 'test@example.com' } as UserNode);

      await service.upsertUser({
        tenantId: 'tenant-1',
        email: 'test@example.com',
      });

      const metrics = service.getMetrics();
      expect(metrics.operations.size).toBe(0);
    });
  });

  // ==========================================================================
  // Retry Logic Tests
  // ==========================================================================

  describe('Retry Logic', () => {
    it('should retry on transient connection error', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      // Fail twice, then succeed
      mockClient.upsertUser
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce({ email: 'test@example.com' } as UserNode);

      const result = await service.upsertUser({
        tenantId: 'tenant-1',
        email: 'test@example.com',
      });

      expect(result).toBeDefined();
      expect(mockClient.upsertUser).toHaveBeenCalledTimes(3);
    });

    it('should apply exponential backoff between retries', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const delays: number[] = [];
      let lastCallTime = Date.now();

      mockClient.upsertUser.mockImplementation(() => {
        const now = Date.now();
        delays.push(now - lastCallTime);
        lastCallTime = now;
        return Promise.reject(new Error('Connection timeout'));
      });

      try {
        await service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        });
      } catch (error) {
        // Expected to fail after retries
      }

      // With retryDelayMs=100 and multiplier=2:
      // attempt 0: immediate (delays[0] ≈ 0)
      // attempt 1: after 100ms sleep (delays[1] ≈ 100)
      // attempt 2: after 200ms sleep (delays[2] ≈ 200)
      // attempt 3: after 400ms sleep (delays[3] ≈ 400)
      expect(delays.length).toBeGreaterThanOrEqual(3);
      expect(delays[1]).toBeGreaterThanOrEqual(80); // ~100ms
      expect(delays[1]).toBeLessThan(200);
      expect(delays[2]).toBeGreaterThanOrEqual(180); // ~200ms
      expect(delays[2]).toBeLessThan(350);
    });

    it('should not retry on non-retryable errors', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      // Validation error (not retryable)
      mockClient.upsertUser.mockRejectedValue(new Error('Validation failed: email required'));

      try {
        await service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        });
      } catch (error) {
        // Expected
      }

      // Should only be called once (no retries)
      expect(mockClient.upsertUser).toHaveBeenCalledTimes(1);
    });

    it('should exhaust retries and throw last error', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const testError = new Error('Connection timeout');
      mockClient.upsertUser.mockRejectedValue(testError);

      await expect(
        service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        }),
      ).rejects.toThrow('Connection timeout');

      // Should be called maxRetries + 1 times (initial + 3 retries = 4)
      expect(mockClient.upsertUser).toHaveBeenCalledTimes(4);
    });

    it('should identify retryable errors correctly', async () => {
      const service = PermissionGraphService.getInstance(testConfig);

      const retryableErrors = [
        new Error('ECONNREFUSED'),
        new Error('ENOTFOUND'),
        new Error('ETIMEDOUT'),
        new Error('Connection timeout'),
        new Error('Service unavailable'),
        new Error('Neo4j.ClientError.Transaction.TransientError'),
      ];

      const nonRetryableErrors = [
        new Error('Validation failed'),
        new Error('Constraint violation'),
        new Error('Syntax error'),
        new Error('Permission denied'),
      ];

      for (const error of retryableErrors) {
        expect((service as any).isRetryableError(error)).toBe(true);
      }

      for (const error of nonRetryableErrors) {
        expect((service as any).isRetryableError(error)).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Circuit Breaker Tests
  // ==========================================================================

  describe('Circuit Breaker', () => {
    it('should open circuit after threshold failures', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      mockClient.upsertUser.mockRejectedValue(new Error('Service error'));

      // Cause failures equal to threshold (3)
      for (let i = 0; i < 3; i++) {
        try {
          await service.upsertUser({
            tenantId: 'tenant-1',
            email: 'test@example.com',
          });
        } catch (error) {
          // Expected
        }
      }

      // Circuit should now be open
      const metrics = service.getMetrics();
      expect(metrics.circuitState).toBe('open');
    });

    it('should reject requests when circuit is open', async () => {
      const service = PermissionGraphService.getInstance(testConfig);

      // Force circuit open
      (service as any).circuitState = 'open';
      (service as any).circuitOpenedAt = new Date();

      await expect(
        service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        }),
      ).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should transition to half-open after timeout', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      // Open circuit
      (service as any).circuitState = 'open';
      (service as any).circuitOpenedAt = new Date(Date.now() - 2000); // 2 seconds ago (timeout is 1s)

      mockClient.upsertUser.mockResolvedValue({ email: 'test@example.com' } as UserNode);

      // Should allow request (circuit moved to half-open)
      await service.upsertUser({
        tenantId: 'tenant-1',
        email: 'test@example.com',
      });

      // After successful request, should be closed
      const metrics = service.getMetrics();
      expect(metrics.circuitState).toBe('closed');
    });

    it('should reopen circuit if half-open request fails', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      // Set half-open state
      (service as any).circuitState = 'half_open';

      mockClient.upsertUser.mockRejectedValue(new Error('Still failing'));

      try {
        await service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        });
      } catch (error) {
        // Expected
      }

      // Circuit should reopen
      const metrics = service.getMetrics();
      expect(metrics.circuitState).toBe('open');
    });

    it('should close circuit after successful half-open request', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      // Set half-open state
      (service as any).circuitState = 'half_open';

      mockClient.upsertUser.mockResolvedValue({ email: 'test@example.com' } as UserNode);

      await service.upsertUser({
        tenantId: 'tenant-1',
        email: 'test@example.com',
      });

      // Circuit should close
      const metrics = service.getMetrics();
      expect(metrics.circuitState).toBe('closed');
    });

    it('should reset failure count on success', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      // Cause some failures (but not enough to open circuit)
      mockClient.upsertUser.mockRejectedValue(new Error('Service error'));

      try {
        await service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        });
      } catch (error) {
        // Expected
      }

      expect((service as any).failureCount).toBeGreaterThan(0);

      // Now succeed
      mockClient.upsertUser.mockResolvedValue({ email: 'test@example.com' } as UserNode);

      await service.upsertUser({
        tenantId: 'tenant-1',
        email: 'test@example.com',
      });

      // Failure count should be reset
      expect((service as any).failureCount).toBe(0);
    });
  });

  // ==========================================================================
  // Wrapped Operations Tests
  // ==========================================================================

  describe('Wrapped Operations', () => {
    it('should wrap initializeSchema', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      await service.initializeSchema();

      expect(mockClient.initializeSchema).toHaveBeenCalled();
    });

    it('should wrap upsertUser', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const input: CreateUserInput = {
        tenantId: 'tenant-1',
        email: 'test@example.com',
        displayName: 'Test User',
      };

      await service.upsertUser(input);

      expect(mockClient.upsertUser).toHaveBeenCalledWith(input);
    });

    it('should wrap getUser', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      await service.getUser('tenant-1', 'test@example.com');

      expect(mockClient.getUser).toHaveBeenCalledWith('tenant-1', 'test@example.com');
    });

    it('should wrap batchUpsertUsers', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const users: CreateUserInput[] = [
        { tenantId: 'tenant-1', email: 'user1@example.com' },
        { tenantId: 'tenant-1', email: 'user2@example.com' },
      ];

      await service.batchUpsertUsers('tenant-1', users);

      expect(mockClient.batchUpsertUsers).toHaveBeenCalledWith('tenant-1', users);
    });

    it('should wrap getUserGroups', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const result = await service.getUserGroups('tenant-1', 'test@example.com', 20);

      expect(mockClient.getUserGroups).toHaveBeenCalledWith('tenant-1', 'test@example.com', 20);
      expect(result).toEqual(['group1', 'group2']);
    });

    it('should wrap getAccessibleDocuments', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const options = { maxDepth: 20, limit: 10000 };
      const result = await service.getAccessibleDocuments('tenant-1', 'test@example.com', options);

      expect(mockClient.getAccessibleDocuments).toHaveBeenCalledWith(
        'tenant-1',
        'test@example.com',
        options,
      );
      expect(result).toEqual(['doc1', 'doc2']);
    });

    it('should wrap getFlattenedPermissions', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const result = await service.getFlattenedPermissions('tenant-1', 'doc-1');

      expect(mockClient.getFlattenedPermissions).toHaveBeenCalledWith('tenant-1', 'doc-1');
      expect(result.allowedUsers).toEqual(['user1@example.com']);
      expect(result.allowedGroups).toEqual(['group1']);
    });

    it('should wrap getGraphStats', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const result = await service.getGraphStats('tenant-1');

      expect(mockClient.getGraphStats).toHaveBeenCalledWith('tenant-1');
      expect(result.userCount).toBe(100);
      expect(result.documentCount).toBe(1000);
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('Error Handling', () => {
    it('should propagate errors after retries exhausted', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const testError = new Error('Connection timeout');
      mockClient.upsertUser.mockRejectedValue(testError);

      await expect(
        service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        }),
      ).rejects.toThrow('Connection timeout');
    });

    it('should handle circuit breaker rejections', async () => {
      const service = PermissionGraphService.getInstance(testConfig);

      // Force circuit open
      (service as any).circuitState = 'open';
      (service as any).circuitOpenedAt = new Date();

      await expect(
        service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        }),
      ).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('should record errors in metrics', async () => {
      const service = PermissionGraphService.getInstance(testConfig);
      const mockClient = (service as any).client;

      const testError = new Error('Service error');
      mockClient.upsertUser.mockRejectedValue(testError);

      try {
        await service.upsertUser({
          tenantId: 'tenant-1',
          email: 'test@example.com',
        });
      } catch (error) {
        // Expected
      }

      const metrics = service.getMetrics();
      const opMetrics = metrics.operations.get('upsertUser');

      expect(opMetrics!.lastError).toBe(testError);
      expect(opMetrics!.lastErrorAt).toBeInstanceOf(Date);
    });
  });
});
