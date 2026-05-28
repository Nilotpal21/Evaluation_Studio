/**
 * TDD lock tests for streaming reask behavior — Slice 2 [ABLP-413]
 *
 * Documents that streaming reask is DEFERRED: when the session is in
 * streaming mode (onChunk present) and a guardrail resolves to 'reask',
 * the runtime falls back to 'block' behavior and emits a
 * 'guardrail_reask_skipped_streaming' trace event. No retry attempted.
 *
 * Non-streaming sessions execute reask normally.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldExecuteReask,
  type ReaskDecisionInput,
} from '../services/execution/reask-executor.js';

describe('reask streaming behavior', () => {
  it('should fall back to block when streaming is active', () => {
    const input: ReaskDecisionInput = {
      primaryAction: 'reask',
      primaryMessage: 'Content violates policy',
      hasReaskViolation: true,
      isStreaming: true,
    };

    const decision = shouldExecuteReask(input);
    expect(decision.shouldReask).toBe(false);
    expect(decision.fallbackAction).toBe('block');
    expect(decision.skipReason).toBe('streaming');
  });

  it('should allow reask when NOT streaming', () => {
    const input: ReaskDecisionInput = {
      primaryAction: 'reask',
      primaryMessage: 'Content violates policy',
      hasReaskViolation: true,
      isStreaming: false,
    };

    const decision = shouldExecuteReask(input);
    expect(decision.shouldReask).toBe(true);
  });

  it('should emit guardrail_reask_skipped_streaming trace reason for streaming sessions', () => {
    // The trace event type is determined by the consumer using the skipReason
    const input: ReaskDecisionInput = {
      primaryAction: 'reask',
      primaryMessage: 'Content violates policy',
      hasReaskViolation: true,
      isStreaming: true,
    };

    const decision = shouldExecuteReask(input);
    expect(decision.skipReason).toBe('streaming');
    // Consumer uses this to emit: { type: 'guardrail_reask_skipped_streaming', data: {...} }
  });

  it('should NOT produce a skipReason when reask is skipped due to precedence (not streaming)', () => {
    const input: ReaskDecisionInput = {
      primaryAction: 'block',
      primaryMessage: 'Blocked',
      hasReaskViolation: true,
      isStreaming: false,
    };

    const decision = shouldExecuteReask(input);
    expect(decision.shouldReask).toBe(false);
    expect(decision.skipReason).toBeUndefined();
  });
});
