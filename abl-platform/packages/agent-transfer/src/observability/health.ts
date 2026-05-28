/**
 * Agent Transfer Health Check
 *
 * Reports the health of the agent transfer subsystem:
 * - Redis connectivity (session store)
 * - SmartAssist reachability
 * - Circuit breaker states
 * - Recovery service status
 *
 * Returns a structured health report with overall status
 * and per-component details.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface ComponentHealth {
  status: HealthStatus;
  message?: string;
  latencyMs?: number;
}

export interface AgentTransferHealthReport {
  status: HealthStatus;
  details: {
    sessionStore: ComponentHealth;
    smartassist: ComponentHealth;
    providers: ComponentHealth;
    recovery: ComponentHealth;
  };
}

export interface HealthCheckDeps {
  /** Ping the Redis instance backing the session store */
  pingSessionStore: () => Promise<boolean>;
  /** Check SmartAssist reachability */
  checkSmartAssist?: () => Promise<boolean>;
  /** Get circuit breaker state: 0=closed, 1=half-open, 2=open */
  getCircuitBreakerState?: () => number;
  /** Check if recovery service is running */
  isRecoveryRunning?: () => boolean;
}

/**
 * Perform a health check of the agent transfer subsystem.
 */
export async function checkAgentTransferHealth(
  deps: HealthCheckDeps,
): Promise<AgentTransferHealthReport> {
  const sessionStore = await checkSessionStore(deps);
  const smartassist = await checkSmartAssist(deps);
  const providers = checkProviders(deps);
  const recovery = checkRecovery(deps);

  const statuses = [sessionStore.status, smartassist.status, providers.status, recovery.status];

  let overall: HealthStatus = 'healthy';
  if (statuses.includes('down')) {
    overall = 'down';
  } else if (statuses.includes('degraded')) {
    overall = 'degraded';
  }

  return {
    status: overall,
    details: { sessionStore, smartassist, providers, recovery },
  };
}

async function checkSessionStore(deps: HealthCheckDeps): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const ok = await deps.pingSessionStore();
    const latencyMs = Date.now() - start;
    if (ok) {
      return { status: 'healthy', latencyMs };
    }
    return { status: 'down', message: 'Redis ping returned false', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      status: 'down',
      message: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  }
}

async function checkSmartAssist(deps: HealthCheckDeps): Promise<ComponentHealth> {
  if (!deps.checkSmartAssist) {
    return { status: 'healthy', message: 'No SmartAssist configured' };
  }
  const start = Date.now();
  try {
    const ok = await deps.checkSmartAssist();
    const latencyMs = Date.now() - start;
    if (ok) {
      return { status: 'healthy', latencyMs };
    }
    return { status: 'degraded', message: 'SmartAssist unreachable', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      status: 'degraded',
      message: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  }
}

function checkProviders(deps: HealthCheckDeps): ComponentHealth {
  if (!deps.getCircuitBreakerState) {
    return { status: 'healthy', message: 'No circuit breaker configured' };
  }
  const state = deps.getCircuitBreakerState();
  if (state === 0) {
    return { status: 'healthy', message: 'Circuit breaker closed' };
  }
  if (state === 1) {
    return { status: 'degraded', message: 'Circuit breaker half-open' };
  }
  return { status: 'down', message: 'Circuit breaker open' };
}

function checkRecovery(deps: HealthCheckDeps): ComponentHealth {
  if (!deps.isRecoveryRunning) {
    return { status: 'healthy', message: 'Recovery not configured' };
  }
  if (deps.isRecoveryRunning()) {
    return { status: 'healthy', message: 'Recovery service running' };
  }
  return { status: 'degraded', message: 'Recovery service not running' };
}
