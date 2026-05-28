/**
 * In-Memory Implementations
 *
 * Memory-backed stores for testing and development.
 * Not suitable for production (no persistence, no cross-pod sharing).
 */

import type {
  IAlertRuleStore,
  ICooldownStore,
  IMetricsReader,
  AlertRule,
  AlertState,
  MetricQuery,
  MetricValue,
} from './interfaces.js';
import { windowToMs } from './threshold-evaluator.js';

// =============================================================================
// MEMORY ALERT RULE STORE
// =============================================================================

export class MemoryAlertRuleStore implements IAlertRuleStore {
  private rules = new Map<string, AlertRule>();

  async getActiveRules(tenantId: string, projectId: string): Promise<AlertRule[]> {
    return Array.from(this.rules.values()).filter(
      (r) => r.tenantId === tenantId && r.projectId === projectId && r.enabled,
    );
  }

  async getAllActiveRules(): Promise<AlertRule[]> {
    return Array.from(this.rules.values()).filter((r) => r.enabled);
  }

  async getRule(tenantId: string, ruleId: string): Promise<AlertRule | null> {
    const rule = this.rules.get(ruleId);
    if (!rule || rule.tenantId !== tenantId) return null;
    return rule;
  }

  async createRule(rule: AlertRule): Promise<void> {
    this.rules.set(rule.id, rule);
  }

  async updateRule(tenantId: string, ruleId: string, updates: Partial<AlertRule>): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (!rule || rule.tenantId !== tenantId) return;
    this.rules.set(ruleId, { ...rule, ...updates, updatedAt: new Date() });
  }

  async deleteRule(tenantId: string, ruleId: string): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (rule && rule.tenantId === tenantId) {
      this.rules.delete(ruleId);
    }
  }
}

// =============================================================================
// MEMORY COOLDOWN STORE
// =============================================================================

export class MemoryCooldownStore implements ICooldownStore {
  private cooldowns = new Map<string, number>(); // ruleId → expiresAt (timestamp)
  private states = new Map<string, AlertState>(); // ruleId → current state

  async isInCooldown(ruleId: string): Promise<boolean> {
    const expiresAt = this.cooldowns.get(ruleId);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.cooldowns.delete(ruleId);
      return false;
    }
    return true;
  }

  async setCooldown(ruleId: string, durationSeconds: number): Promise<void> {
    this.cooldowns.set(ruleId, Date.now() + durationSeconds * 1000);
  }

  async clearCooldown(ruleId: string): Promise<void> {
    this.cooldowns.delete(ruleId);
  }

  async getAlertState(ruleId: string): Promise<AlertState> {
    return this.states.get(ruleId) ?? 'ok';
  }

  async setAlertState(ruleId: string, state: AlertState): Promise<void> {
    this.states.set(ruleId, state);
  }
}

// =============================================================================
// MEMORY METRICS READER
// =============================================================================

/**
 * In-memory metrics reader for testing.
 * Pre-load metric values with `setMetric()`.
 */
export class MemoryMetricsReader implements IMetricsReader {
  private metrics = new Map<string, number>();

  /** Set a metric value for testing. Key format: `${tenantId}:${projectId}:${metric}` */
  setMetric(tenantId: string, projectId: string, metric: string, value: number): void {
    this.metrics.set(`${tenantId}:${projectId}:${metric}`, value);
  }

  async queryMetric(query: MetricQuery): Promise<MetricValue> {
    const key = `${query.tenantId}:${query.projectId}:${query.metric}`;
    const value = this.metrics.get(key) ?? 0;
    const windowMs = windowToMs(query.window);
    const now = new Date();

    return {
      value,
      sampleCount: 1,
      windowStart: new Date(now.getTime() - windowMs),
      windowEnd: now,
    };
  }
}
