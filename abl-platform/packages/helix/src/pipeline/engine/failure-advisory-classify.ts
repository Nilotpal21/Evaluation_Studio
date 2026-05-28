/**
 * Failure-advisory classification helpers.
 *
 * Pure helpers extracted verbatim from `pipeline-engine.ts`:
 *
 *   - `classifyFailureAdvisoryCategory(result)` — maps a StageResult onto
 *     one of the FailureAdvisoryCategory labels used downstream.
 *   - `isTransportFailure(sourceError)` — detects DNS / outbound-network
 *     error strings coming back from oracle CLIs.
 *   - `isLoginFailure(sourceError)` — detects the Claude `/login` prompt
 *     string.
 *   - `isCodexLocalStateFailure(sourceError)` — detects Codex local-state
 *     corruption (readonly DB, permission-denied under `~/.codex`).
 *   - `shouldBypassFailureAdvisoryModel(cat, err)` — decides whether the
 *     model-backed failure advisory step should be skipped (transport /
 *     login / local-state failures get a deterministic advisory instead).
 *   - `isFailureAdvisoryEligible(stage, result)` — decides whether a
 *     blocking stage failure should trigger the failure-advisory loop
 *     at all (guards against user-rejections, stale-clone baselines,
 *     non-retryable categories).
 *
 * No engine state, no I/O. Behavior unchanged.
 */
import type { FailureAdvisoryCategory, StageDefinition, StageResult } from '../../types.js';
import { isPlanValidationStructuredOutputError } from './retry-context.js';
import { isBlockingStageResult } from './stage-predicates.js';

export function classifyFailureAdvisoryCategory(result: StageResult): FailureAdvisoryCategory {
  if (result.timeoutEvents && result.timeoutEvents.length > 0) {
    return 'timeout';
  }

  if (result.status === 'looped') {
    return 'loop-limit';
  }

  if (result.qualityGate && !result.qualityGate.passed) {
    return 'quality-gate';
  }

  if (
    result.error &&
    /exit criteria|test-lock|architecture review blocked|regression suite/i.test(result.error)
  ) {
    return 'quality-gate';
  }

  if (result.error && isPlanValidationStructuredOutputError(result.error)) {
    return 'structured-output';
  }

  if (
    result.error &&
    /structured output|structured contract|schema validation|json failed schema validation/i.test(
      result.error,
    )
  ) {
    return 'structured-output';
  }

  if (
    result.error &&
    /\bout-of-scope\b|\bworking tree\b|\bworkspace guard\b|\bworkspace drift\b|\bworkspace scope\b/i.test(
      result.error,
    )
  ) {
    return 'workspace-scope';
  }

  if (result.error) {
    return 'model-error';
  }

  return 'unknown';
}

export function isTransportFailure(sourceError: string): boolean {
  return /\b(failed to lookup address information|nodename nor servname provided|name or service not known|could not resolve host|temporary failure in name resolution|api\.openai\.com)\b/i.test(
    sourceError,
  );
}

export function isLoginFailure(sourceError: string): boolean {
  return /\bnot logged in · please run \/login\b/i.test(sourceError);
}

export function isCodexLocalStateFailure(sourceError: string): boolean {
  return /\b(readonly database|permission denied.*\.codex)\b/i.test(sourceError);
}

/**
 * Inactivity stall — typically Codex stuck for >900s without producing a
 * model turn. Retrying on the same executor is unlikely to recover; better
 * to switch to claude-code with the existing seam evidence.
 */
export function isInactivityStallFailure(sourceError: string): boolean {
  return /\bstalled after \d+s of inactivity\b/i.test(sourceError);
}

/**
 * Credit / billing exhaustion on the model provider. No retry can succeed
 * until the operator tops up the account. Pause and prompt rather than
 * burning budget on retry storms.
 */
export function isCreditBalanceFailure(sourceError: string): boolean {
  return /\b(credit balance is too low|insufficient_quota|insufficient credits|billing|payment required)\b/i.test(
    sourceError,
  );
}

export function shouldBypassFailureAdvisoryModel(
  failureCategory: FailureAdvisoryCategory,
  sourceError: string,
): boolean {
  if (failureCategory !== 'model-error') {
    return false;
  }

  return (
    isTransportFailure(sourceError) ||
    isLoginFailure(sourceError) ||
    isCodexLocalStateFailure(sourceError)
  );
}

export function isFailureAdvisoryEligible(stage: StageDefinition, result: StageResult): boolean {
  if (!isBlockingStageResult(result)) {
    return false;
  }

  if (stage.type === 'user-checkpoint') {
    return false;
  }

  const error = result.error?.trim();
  if (!error) {
    return result.status === 'looped';
  }

  if (error === 'User rejected' || error === 'Aborted') {
    return false;
  }

  // Stale-clone-baseline is a deterministic user-action-required condition
  // (refresh the clone from the current source tip). Retrying will never help.
  if (/\bStale clone baseline\b/i.test(error)) {
    return false;
  }

  const category = classifyFailureAdvisoryCategory(result);
  switch (category) {
    case 'timeout':
    case 'quality-gate':
    case 'structured-output':
    case 'workspace-scope':
    case 'loop-limit':
      return true;
    case 'model-error':
      return (
        /\b(turns?|stall(?:ed)?|inactivity|credential|permission|auth|enoent|spawn|lookup address|could not resolve host|temporary failure in name resolution)\b/i.test(
          error,
        ) ||
        /\bapi\.openai\.com\b/i.test(error) ||
        /\bnot logged in · please run \/login\b/i.test(error) ||
        /\bnot found\b/i.test(error) ||
        Boolean(
          result.executionSummary &&
          (result.executionSummary.shellCommandEvents > 0 ||
            result.executionSummary.outputEvents > 0 ||
            result.executionSummary.toolUseEvents > 0),
        )
      );
    default:
      return false;
  }
}
