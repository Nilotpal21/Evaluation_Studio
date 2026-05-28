/**
 * Alert Scheduler
 *
 * Periodically evaluates alert rules against metric values.
 * Follows the same polling pattern as EvaluationDispatcher:
 * - Configurable poll interval
 * - Concurrency-limited fan-out
 * - Cooldown tracking to prevent notification storms
 * - Event emission for audit trail
 */

import type { IEventEmitter } from '../interfaces/event-emitter.js';
import type {
  IAlertScheduler,
  IAlertRuleStore,
  ICooldownStore,
  IMetricsReader,
  IAlertNotifier,
  AlertRule,
  AlertSchedulerStats,
} from './interfaces.js';
import { evaluateRule, shouldNotify } from './threshold-evaluator.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface AlertSchedulerConfig {
  /** Store for alert rules */
  ruleStore: IAlertRuleStore;
  /** Store for cooldown state */
  cooldownStore: ICooldownStore;
  /** Reader for metric aggregates */
  metricsReader: IMetricsReader;
  /** Notifier for delivering alerts */
  notifier: IAlertNotifier;
  /** Event emitter for audit trail */
  emitter?: IEventEmitter;
  /** Poll interval in ms (0 = manual trigger only) */
  pollIntervalMs?: number;
  /** Maximum concurrent rule evaluations per cycle */
  maxConcurrency?: number;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class AlertScheduler implements IAlertScheduler {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrency: number;
  private stats: AlertSchedulerStats = {
    evaluationsRun: 0,
    alertsFired: 0,
    alertsResolved: 0,
    alertsSkippedCooldown: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
  };

  constructor(private readonly config: AlertSchedulerConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? 0;
    this.maxConcurrency = config.maxConcurrency ?? 10;
  }

  async start(): Promise<void> {
    this.running = true;

    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        this.evaluateAll().catch(() => {
          // Non-fatal: will retry on next interval
        });
      }, this.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getStats(): AlertSchedulerStats {
    return { ...this.stats };
  }

  async evaluateAll(): Promise<void> {
    if (!this.running) return;

    const rules = await this.config.ruleStore.getAllActiveRules();
    if (rules.length === 0) return;

    // Process in chunks of maxConcurrency
    for (let i = 0; i < rules.length; i += this.maxConcurrency) {
      const chunk = rules.slice(i, i + this.maxConcurrency);
      await Promise.allSettled(chunk.map((rule) => this.evaluateRuleSafe(rule)));
    }
  }

  /**
   * Evaluate a single rule. Never throws — errors are counted in stats.
   */
  private async evaluateRuleSafe(rule: AlertRule): Promise<void> {
    try {
      // 1. Check cooldown
      const inCooldown = await this.config.cooldownStore.isInCooldown(rule.id);
      if (inCooldown) {
        this.stats.alertsSkippedCooldown++;
        return;
      }

      // 2. Query metric
      const metricValue = await this.config.metricsReader.queryMetric({
        tenantId: rule.tenantId,
        projectId: rule.projectId,
        metric: rule.metric,
        window: rule.window,
        agentName: rule.agentName,
        eventTypes: rule.eventTypes,
      });

      // 3. Get previous state
      const previousState = await this.config.cooldownStore.getAlertState(rule.id);

      // 4. Evaluate threshold
      const evaluation = evaluateRule(rule, metricValue, previousState);
      this.stats.evaluationsRun++;

      // 5. Update state
      await this.config.cooldownStore.setAlertState(rule.id, evaluation.state);

      // 6. Check if notification needed
      if (!shouldNotify(evaluation)) return;

      // 7. Set cooldown on firing
      if (evaluation.state === 'firing') {
        await this.config.cooldownStore.setCooldown(rule.id, rule.cooldownSeconds);
        this.stats.alertsFired++;
      } else if (evaluation.state === 'resolved') {
        await this.config.cooldownStore.clearCooldown(rule.id);
        this.stats.alertsResolved++;
      }

      // 8. Emit alert event
      if (this.config.emitter) {
        this.config.emitter.emit({
          event_type: evaluation.state === 'firing' ? 'alert.firing' : 'alert.resolved',
          tenant_id: rule.tenantId,
          project_id: rule.projectId,
          timestamp: new Date(),
          data: {
            rule_id: rule.id,
            rule_name: rule.name,
            severity: rule.severity,
            metric: rule.metric,
            current_value: evaluation.metricValue,
            threshold: rule.threshold,
            operator: rule.operator,
            state: evaluation.state,
            previous_state: evaluation.previousState,
          },
        } as unknown);
      }

      // 9. Deliver notification
      const result = await this.config.notifier.notify(rule, evaluation);
      this.stats.notificationsSent += result.sent;
      this.stats.notificationsFailed += result.failed;
    } catch {
      // Rule evaluation failed — non-fatal, continue with other rules
    }
  }
}
