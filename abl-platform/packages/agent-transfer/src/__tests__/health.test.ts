import { describe, it, expect, vi } from 'vitest';
import { checkAgentTransferHealth, type HealthCheckDeps } from '../observability/health.js';

describe('checkAgentTransferHealth', () => {
  it('returns healthy when all systems are up', async () => {
    const deps: HealthCheckDeps = {
      pingSessionStore: vi.fn().mockResolvedValue(true),
      checkSmartAssist: vi.fn().mockResolvedValue(true),
      getCircuitBreakerState: vi.fn().mockReturnValue(0),
      isRecoveryRunning: vi.fn().mockReturnValue(true),
    };

    const report = await checkAgentTransferHealth(deps);

    expect(report.status).toBe('healthy');
    expect(report.details.sessionStore.status).toBe('healthy');
    expect(report.details.smartassist.status).toBe('healthy');
    expect(report.details.providers.status).toBe('healthy');
    expect(report.details.recovery.status).toBe('healthy');
  });

  it('returns degraded when circuit breaker is open', async () => {
    const deps: HealthCheckDeps = {
      pingSessionStore: vi.fn().mockResolvedValue(true),
      checkSmartAssist: vi.fn().mockResolvedValue(true),
      getCircuitBreakerState: vi.fn().mockReturnValue(2), // open
      isRecoveryRunning: vi.fn().mockReturnValue(true),
    };

    const report = await checkAgentTransferHealth(deps);

    expect(report.status).toBe('down');
    expect(report.details.providers.status).toBe('down');
    expect(report.details.providers.message).toContain('open');
  });

  it('returns degraded when circuit breaker is half-open', async () => {
    const deps: HealthCheckDeps = {
      pingSessionStore: vi.fn().mockResolvedValue(true),
      getCircuitBreakerState: vi.fn().mockReturnValue(1), // half-open
    };

    const report = await checkAgentTransferHealth(deps);

    expect(report.status).toBe('degraded');
    expect(report.details.providers.status).toBe('degraded');
  });

  it('returns down when Redis is disconnected', async () => {
    const deps: HealthCheckDeps = {
      pingSessionStore: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };

    const report = await checkAgentTransferHealth(deps);

    expect(report.status).toBe('down');
    expect(report.details.sessionStore.status).toBe('down');
    expect(report.details.sessionStore.message).toContain('Connection refused');
  });

  it('returns degraded when SmartAssist is unreachable', async () => {
    const deps: HealthCheckDeps = {
      pingSessionStore: vi.fn().mockResolvedValue(true),
      checkSmartAssist: vi.fn().mockResolvedValue(false),
    };

    const report = await checkAgentTransferHealth(deps);

    expect(report.status).toBe('degraded');
    expect(report.details.smartassist.status).toBe('degraded');
  });

  it('returns degraded when recovery service is not running', async () => {
    const deps: HealthCheckDeps = {
      pingSessionStore: vi.fn().mockResolvedValue(true),
      isRecoveryRunning: vi.fn().mockReturnValue(false),
    };

    const report = await checkAgentTransferHealth(deps);

    expect(report.status).toBe('degraded');
    expect(report.details.recovery.status).toBe('degraded');
  });

  it('returns healthy when optional deps are not configured', async () => {
    const deps: HealthCheckDeps = {
      pingSessionStore: vi.fn().mockResolvedValue(true),
      // No smartassist, no circuit breaker, no recovery
    };

    const report = await checkAgentTransferHealth(deps);

    expect(report.status).toBe('healthy');
    expect(report.details.smartassist.status).toBe('healthy');
    expect(report.details.providers.status).toBe('healthy');
    expect(report.details.recovery.status).toBe('healthy');
  });

  it('includes latency in session store health', async () => {
    const deps: HealthCheckDeps = {
      pingSessionStore: vi.fn().mockResolvedValue(true),
    };

    const report = await checkAgentTransferHealth(deps);

    expect(report.details.sessionStore.latencyMs).toBeDefined();
    expect(typeof report.details.sessionStore.latencyMs).toBe('number');
  });
});
