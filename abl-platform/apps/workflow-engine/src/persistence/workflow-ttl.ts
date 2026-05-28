/**
 * Workflow Mongo-TTL helpers (LLD §6.1, §6.2).
 *
 * `computeExpiresAt(status, mailbox?)` returns the `expiresAt` Date for a
 * terminal-status write, or `null` when either:
 *   1. `WORKFLOW_MONGO_TTL_ENABLED=false` (flag off), OR
 *   2. The status is not terminal for the entity, OR
 *   3. The human-task mailbox is not `'workflow'` (HLD §5 scope guard).
 *
 * The caller writes the returned value into the `expiresAt` column — the
 * Mongo TTL partial-filter index does the rest. Non-terminal updates MUST
 * keep `expiresAt: null` so the index never reaps an in-flight row.
 */

const TERMINAL_EXECUTION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);

const TERMINAL_HUMAN_TASK_STATUSES = new Set(['completed', 'expired', 'cancelled']);

const DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days per LLD §6.1

function ttlSeconds(): number {
  const raw = process.env.WORKFLOW_MONGO_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

function ttlFlagOn(): boolean {
  return process.env.WORKFLOW_MONGO_TTL_ENABLED === 'true';
}

/**
 * Compute `expiresAt` for a workflow_execution write. Returns a Date when
 * the transition is terminal AND the TTL flag is on; null otherwise.
 */
export function computeExecutionExpiresAt(status: string, now: Date = new Date()): Date | null {
  if (!ttlFlagOn()) return null;
  if (!TERMINAL_EXECUTION_STATUSES.has(status)) return null;
  return new Date(now.getTime() + ttlSeconds() * 1000);
}

/**
 * Compute `expiresAt` for a human_task write. Returns a Date only when:
 *   - TTL flag is on,
 *   - mailbox is `'workflow'` (HLD §5 scope — other mailboxes opt out),
 *   - status is in the terminal set.
 */
export function computeHumanTaskExpiresAt(
  status: string,
  mailbox: string | undefined,
  now: Date = new Date(),
): Date | null {
  if (!ttlFlagOn()) return null;
  if (mailbox !== 'workflow') return null;
  if (!TERMINAL_HUMAN_TASK_STATUSES.has(status)) return null;
  return new Date(now.getTime() + ttlSeconds() * 1000);
}

export const WORKFLOW_TTL_DEFAULT_SECONDS = DEFAULT_TTL_SECONDS;

/**
 * Mailbox-agnostic variant used by the human-task aggregation-pipeline
 * update — returns the Date to write when the TTL flag is on and the
 * status is in the human-task terminal set, else `null`. The caller's
 * `$cond` pins the Date onto `expiresAt` only for `mailbox='workflow'`.
 */
export function computeHumanTaskTerminalCandidate(
  status: string,
  now: Date = new Date(),
): Date | null {
  if (!ttlFlagOn()) return null;
  if (!TERMINAL_HUMAN_TASK_STATUSES.has(status)) return null;
  return new Date(now.getTime() + ttlSeconds() * 1000);
}
