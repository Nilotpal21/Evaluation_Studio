/** Matches valid JS/Python identifier names for workflow input variables. */
export const VAR_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Statuses that indicate an execution is still active (Run button shows Stop). */
export const ACTIVE_EXEC_STATUSES = new Set([
  'running',
  'waiting_human',
  'waiting_human_task',
  'waiting_approval',
  'waiting_callback',
  'waiting_delay',
]);
