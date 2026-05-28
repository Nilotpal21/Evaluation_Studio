/**
 * Alerting Engine Interfaces
 *
 * Defines contracts for the threshold-based alerting system:
 * - AlertRule: Defines metric, threshold, window, severity, and notification config
 * - IAlertRuleStore: CRUD for alert rules (backend-agnostic)
 * - ICooldownStore: Tracks alert cooldown state
 * - IMetricsReader: Queries aggregated metric data
 * - IAlertNotifier: Delivers alert notifications
 */

// =============================================================================
// ALERT RULE
// =============================================================================

/** Severity levels for alerts */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** State of an alert */
export type AlertState = 'ok' | 'firing' | 'resolved' | 'acknowledged';

/** Comparison operators for threshold checks */
export type ThresholdOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

/** Time window for metric aggregation */
export interface AlertWindow {
  /** Duration value */
  value: number;
  /** Duration unit */
  unit: 'minutes' | 'hours' | 'days';
}

/** Notification channel configuration */
export interface NotificationChannel {
  type: 'webhook';
  /** Webhook URL for delivery */
  url: string;
  /** Optional secret for HMAC signing */
  secret?: string;
  /** Custom headers to include */
  headers?: Record<string, string>;
}

/** A single alert rule definition */
export interface AlertRule {
  /** Unique rule identifier */
  id: string;
  /** Tenant scope */
  tenantId: string;
  /** Project scope */
  projectId: string;
  /** Human-readable name */
  name: string;
  /** Description of what this alert monitors */
  description?: string;
  /** Whether this rule is active */
  enabled: boolean;
  /** Metric to monitor (e.g., 'error_rate', 'avg_latency_ms', 'session_count') */
  metric: string;
  /** Comparison operator */
  operator: ThresholdOperator;
  /** Threshold value to compare against */
  threshold: number;
  /** Time window for aggregation */
  window: AlertWindow;
  /** Severity level */
  severity: AlertSeverity;
  /** Cooldown period in seconds after firing before re-checking */
  cooldownSeconds: number;
  /** Notification channels to deliver to */
  channels: NotificationChannel[];
  /** Optional: filter to specific agent */
  agentName?: string;
  /** Optional: filter to specific event types */
  eventTypes?: string[];
  /** Metadata for tracking */
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// METRIC QUERY
// =============================================================================

/** Parameters for querying a metric value */
export interface MetricQuery {
  tenantId: string;
  projectId: string;
  /** Metric name (maps to aggregation column in materialized view) */
  metric: string;
  /** Time window to aggregate over */
  window: AlertWindow;
  /** Optional agent filter */
  agentName?: string;
  /** Optional event type filter */
  eventTypes?: string[];
}

/** Result of a metric query */
export interface MetricValue {
  /** The computed metric value */
  value: number;
  /** Number of data points in the window */
  sampleCount: number;
  /** Start of the aggregation window */
  windowStart: Date;
  /** End of the aggregation window */
  windowEnd: Date;
}

// =============================================================================
// ALERT EVALUATION
// =============================================================================

/** Result of evaluating a single alert rule */
export interface AlertEvaluation {
  ruleId: string;
  tenantId: string;
  projectId: string;
  /** Whether the threshold was breached */
  breached: boolean;
  /** The metric value that was checked */
  metricValue: number;
  /** The threshold that was checked against */
  threshold: number;
  /** The operator used */
  operator: ThresholdOperator;
  /** Current alert state */
  state: AlertState;
  /** Previous alert state */
  previousState: AlertState;
  /** Evaluation timestamp */
  evaluatedAt: Date;
}

/** Stats from the alert scheduler */
export interface AlertSchedulerStats {
  evaluationsRun: number;
  alertsFired: number;
  alertsResolved: number;
  alertsSkippedCooldown: number;
  notificationsSent: number;
  notificationsFailed: number;
}

// =============================================================================
// PROVIDER INTERFACES
// =============================================================================

/**
 * Store for alert rule CRUD.
 * Backend-agnostic — runtime injects a concrete implementation.
 */
export interface IAlertRuleStore {
  /** Get all active rules (enabled only) */
  getActiveRules(tenantId: string, projectId: string): Promise<AlertRule[]>;
  /** Get all active rules across all tenants (for scheduler) */
  getAllActiveRules(): Promise<AlertRule[]>;
  /** Get a single rule by ID (tenant-scoped) */
  getRule(tenantId: string, ruleId: string): Promise<AlertRule | null>;
  /** Create a new rule */
  createRule(rule: AlertRule): Promise<void>;
  /** Update a rule */
  updateRule(tenantId: string, ruleId: string, updates: Partial<AlertRule>): Promise<void>;
  /** Delete a rule */
  deleteRule(tenantId: string, ruleId: string): Promise<void>;
}

/**
 * Cooldown state tracking.
 * Uses Redis with TTL for automatic expiry.
 */
export interface ICooldownStore {
  /** Check if an alert rule is in cooldown */
  isInCooldown(ruleId: string): Promise<boolean>;
  /** Set cooldown for a rule */
  setCooldown(ruleId: string, durationSeconds: number): Promise<void>;
  /** Clear cooldown for a rule */
  clearCooldown(ruleId: string): Promise<void>;
  /** Track the current state of an alert */
  getAlertState(ruleId: string): Promise<AlertState>;
  /** Update the current state of an alert */
  setAlertState(ruleId: string, state: AlertState): Promise<void>;
}

/**
 * Reads aggregated metrics from the storage backend.
 * Queries materialized views (ClickHouse) or in-memory aggregates.
 */
export interface IMetricsReader {
  /** Query a metric value for the given parameters */
  queryMetric(query: MetricQuery): Promise<MetricValue>;
}

/**
 * Delivers alert notifications to configured channels.
 */
export interface IAlertNotifier {
  /** Send an alert notification */
  notify(rule: AlertRule, evaluation: AlertEvaluation): Promise<{ sent: number; failed: number }>;
}

// =============================================================================
// SCHEDULER INTERFACE
// =============================================================================

/**
 * The alert scheduler periodically evaluates alert rules against metrics.
 */
export interface IAlertScheduler {
  /** Start the scheduler */
  start(): Promise<void>;
  /** Stop the scheduler */
  stop(): Promise<void>;
  /** Get scheduler statistics */
  getStats(): AlertSchedulerStats;
  /** Manually trigger evaluation of all rules */
  evaluateAll(): Promise<void>;
}
