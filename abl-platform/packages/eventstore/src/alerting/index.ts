/**
 * Alerting Engine
 *
 * Threshold-based alerting for platform metrics.
 * Monitors materialized views, fires alerts on threshold breaches,
 * delivers notifications via webhooks, and tracks cooldown state.
 *
 * Usage:
 *   import { AlertScheduler, MemoryAlertRuleStore, MemoryCooldownStore } from '@abl/eventstore';
 */

// Interfaces & types
export type {
  AlertSeverity,
  AlertState,
  ThresholdOperator,
  AlertWindow,
  NotificationChannel,
  AlertRule,
  MetricQuery,
  MetricValue,
  AlertEvaluation,
  AlertSchedulerStats,
  IAlertRuleStore,
  ICooldownStore,
  IMetricsReader,
  IAlertNotifier,
  IAlertScheduler,
} from './interfaces.js';

// Threshold evaluator (pure functions)
export {
  checkThreshold,
  resolveAlertState,
  evaluateRule,
  shouldNotify,
  windowToMs,
} from './threshold-evaluator.js';

// Alert scheduler
export { AlertScheduler, type AlertSchedulerConfig } from './alert-scheduler.js';

// Alert notifier
export {
  AlertNotifier,
  type AlertNotifierConfig,
  type WebhookDeliveryFn,
} from './alert-notifier.js';

// Memory implementations (for testing / dev)
export { MemoryAlertRuleStore, MemoryCooldownStore, MemoryMetricsReader } from './memory-stores.js';
