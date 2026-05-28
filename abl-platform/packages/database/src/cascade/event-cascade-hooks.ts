/**
 * Event Cascade Hooks
 *
 * Optional hook registration for eventstore GDPR cascade operations.
 * The runtime registers these hooks at startup so that cascade delete
 * functions can also clean up eventstore data without the database
 * package depending on @abl/eventstore directly.
 */

export interface EventCascadeHook {
  deleteBySessionIds: (tenantId: string, sessionIds: string[]) => Promise<void>;
  deleteTenant: (tenantId: string) => Promise<void>;
  /**
   * Optional — called by workflow-engine GDPR cascade once the
   * workflow-execution-event-sourcing ClickHouse pipeline is live
   * (LLD §3.4, Phase 4 wiring). Left optional so existing hook
   * implementations (e.g. the runtime's eventstore singleton) need
   * no immediate update and the feature-work commit can stay additive.
   *
   * Callers MUST use optional chaining: `hook.deleteByExecutionIds?.(…)`.
   */
  deleteByExecutionIds?: (tenantId: string, executionIds: string[]) => Promise<void>;
}

let _hook: EventCascadeHook | null = null;

/**
 * Register an event cascade hook. Called by the runtime during startup.
 */
export function registerEventCascadeHook(hook: EventCascadeHook): void {
  _hook = hook;
}

/**
 * Get the registered event cascade hook, or null if not registered.
 */
export function getEventCascadeHook(): EventCascadeHook | null {
  return _hook;
}

/**
 * Test helper — clear the registered hook.
 */
export function _resetEventCascadeHook(): void {
  _hook = null;
}
