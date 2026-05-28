/**
 * Hard limits and tuning constants for the Arch AI v2 turn engine.
 *
 * Source of truth for every bound in spec sections:
 *   - §5.7 (Error classification, retries, bounded execution)
 *   - §5.5 (BUILD specifics)
 *   - §6.4 (Session lock and concurrent writes)
 *   - §6.4.1 (Lock fencing and worker failure recovery)
 *
 * All consumers MUST import constants from here — no magic numbers elsewhere.
 * Env vars may override at runtime for tenant-specific tuning; defaults live in code.
 *
 * See also: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md
 */

/**
 * Per-turn and per-session bounded-execution limits.
 * Enforcement timing is documented in spec §5.7:
 *   - Turn start: MAX_TURNS_PER_SESSION, MAX_USD_PER_SESSION
 *   - After each LLM round (on finish): MAX_TOOL_CALLS_PER_TURN, MAX_TOKENS_PER_TURN, MAX_USD_PER_TURN
 *   - Per tool.execute: TOOL_INVOCATION_TIMEOUT_MS (via AbortSignal)
 *   - Signature dedup: TOOL_SELF_CORRECT_RETRIES per (toolName + hash(args))
 *   - LLM stream watchdog: TURN_SOFT_TIMEOUT_MS, LLM_FIRST_TOKEN_TIMEOUT_MS
 *   - Pending-interactive age on reconnect: INTERACTIVE_TTL_MS, INTERACTIVE_NUDGE_MS
 */
export const ARCH_AI_TURN = {
  /** Max tool calls within a single turn before forcing commit. Retries count against this. */
  MAX_TOOL_CALLS_PER_TURN: 25,

  /** Max total turns a session can accrue before it must be archived. */
  MAX_TURNS_PER_SESSION: 200,

  /** Input + output tokens combined per turn. */
  MAX_TOKENS_PER_TURN: 150_000,

  /** USD budget per turn (estimate via packages/compiler/src/platform/llm/model-registry.ts pricing). */
  MAX_USD_PER_TURN: 2.0,

  /** Cumulative USD budget across all turns in a single session. */
  MAX_USD_PER_SESSION: 25.0,

  /** Soft watchdog — emits turn_soft_timeout well before Redis lock TURN_MAX_MS expires. */
  TURN_SOFT_TIMEOUT_MS: 5 * 60 * 1000,

  /** Max retries per (toolName + hash(args)) signature before injecting REPEAT_CALL_DETECTED. */
  TOOL_SELF_CORRECT_RETRIES: 3,

  /** Max wall time for a single tool.execute call before AbortSignal fires. */
  TOOL_INVOCATION_TIMEOUT_MS: 30_000,

  /** Max wait for first LLM token before aborting stream with model_timeout. */
  LLM_FIRST_TOKEN_TIMEOUT_MS: 90_000,

  /** Max age of a pending interactive widget before auto-expire on reconnect (24h). */
  INTERACTIVE_TTL_MS: 24 * 60 * 60 * 1000,

  /** Emit a status nudge after this many ms if user has not responded to a widget. */
  INTERACTIVE_NUDGE_MS: 60_000,

  /**
   * Truncate streamedPresentation fields (thinking, activityGroups) above this size
   * before persisting on StoredMessage. CLAUDE.md Core Invariant 6 "compress before storing".
   */
  MAX_STREAMED_PRESENTATION_BYTES: 10_000,

  /** IN_PROJECT sessions idle-archive TTL (30 days — not the 10-min onboarding TTL). */
  IN_PROJECT_SESSION_IDLE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
} as const;

/**
 * BUILD-phase specific bounds. Consumed by BuildRunner.
 */
export const ARCH_AI_BUILD = {
  /** Max agents compiling in parallel per BUILD turn. */
  AGENT_CONCURRENCY: 8,

  /** Aggregator emits at most one status event per this interval during BUILD. */
  STATUS_THROTTLE_MS: 500,

  /** Per-agent compile-fix retries before marking agent as error. */
  MAX_FIX_ROUNDS: 3,

  /** Per-agent compile wall-time timeout. */
  AGENT_TIMEOUT_MS: 180_000,

  /**
   * Fraction of agents that must compile successfully for BUILD to auto-advance.
   * Below threshold emits gate with retry_failed / proceed_anyway options.
   */
  BUILD_SUCCESS_THRESHOLD: 0.5,
} as const;

/**
 * Session lock lifetime and reconciler cadence.
 * Referenced by session-lock.ts and session-reconciler.ts.
 */
export const ARCH_AI_LOCK = {
  /** Redis lock PX — hard ceiling on any single turn's execution time. */
  TURN_MAX_MS: 10 * 60 * 1000,

  /** Worker renews its own lock at this interval to avoid expiry during long turns. */
  LOCK_RENEW_INTERVAL_MS: 30_000,

  /** Reconciler scan cadence — every pod runs its own reconciler (no leader election). */
  RECONCILER_INTERVAL_MS: 60_000,

  /** Randomize reconciler startup delay per pod to stagger cross-pod scans. */
  RECONCILER_STARTUP_JITTER_MS: 60_000,

  /** Age threshold for orphaned-lock detection: session.activeTurnLock.renewedAt < now - this. */
  ORPHAN_AGE_MS: 90_000,

  /** SIGTERM graceful drain window — drain() waits this long for active turns to commit. */
  DRAIN_TIMEOUT_MS: 30_000,
} as const;
