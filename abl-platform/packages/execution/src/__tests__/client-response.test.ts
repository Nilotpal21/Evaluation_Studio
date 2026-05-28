import { describe, it, expect } from 'vitest';
import { toClientResponse } from '../types.js';
import type { ExecutionStatus } from '../types.js';

describe('toClientResponse', () => {
  // ===========================================================================
  // SUCCESS CASES
  // ===========================================================================

  describe('success cases', () => {
    it('completed execution with resultData.response extracts the response', () => {
      const result = toClientResponse({
        status: 'completed',
        resultData: { response: 'Hello from the agent' },
      });

      expect(result).toEqual({
        success: true,
        response: 'Hello from the agent',
        resultData: { response: 'Hello from the agent' },
        error: undefined,
      });
    });

    it('completed execution with resultData.text fallback uses text', () => {
      const result = toClientResponse({
        status: 'completed',
        resultData: { text: 'Fallback text response' },
      });

      expect(result).toEqual({
        success: true,
        response: 'Fallback text response',
        resultData: { text: 'Fallback text response' },
        error: undefined,
      });
    });

    it('completed execution with top-level response field takes priority over resultData', () => {
      const result = toClientResponse({
        status: 'completed',
        response: 'Top-level response',
        resultData: { response: 'Should be ignored', text: 'Also ignored' },
      });

      expect(result.success).toBe(true);
      expect(result.response).toBe('Top-level response');
      // resultData is still passed through
      expect(result.resultData).toEqual({ response: 'Should be ignored', text: 'Also ignored' });
    });

    it('completed execution with empty resultData returns empty response', () => {
      const result = toClientResponse({
        status: 'completed',
        resultData: {},
      });

      expect(result).toEqual({
        success: true,
        response: '',
        resultData: undefined,
        error: undefined,
      });
    });

    it('running status is treated as success', () => {
      const result = toClientResponse({
        status: 'running',
        response: 'Still going',
      });

      expect(result.success).toBe(true);
      expect(result.response).toBe('Still going');
    });

    it('queued status is treated as success', () => {
      const result = toClientResponse({
        status: 'queued',
      });

      expect(result.success).toBe(true);
    });

    it('resuming status is treated as success', () => {
      const result = toClientResponse({
        status: 'resuming',
      });

      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // FAILURE CASES
  // ===========================================================================

  describe('failure cases', () => {
    it('failed status with error preserves the error code and message', () => {
      const result = toClientResponse({
        status: 'failed',
        error: { code: 'MODEL_TIMEOUT', message: 'LLM call timed out after 30s' },
      });

      expect(result).toEqual({
        success: false,
        response: '',
        error: { code: 'MODEL_TIMEOUT', message: 'LLM call timed out after 30s' },
      });
    });

    it('failed status without error produces a generic EXECUTION_FAILED error', () => {
      const result = toClientResponse({
        status: 'failed',
      });

      expect(result).toEqual({
        success: false,
        response: '',
        error: { code: 'EXECUTION_FAILED', message: 'Execution failed without details' },
      });
    });

    it('cancelled status returns success: false', () => {
      const result = toClientResponse({
        status: 'cancelled',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'EXECUTION_FAILED',
        message: 'Execution failed without details',
      });
    });

    it('preempted status returns success: false', () => {
      const result = toClientResponse({
        status: 'preempted',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'EXECUTION_FAILED',
        message: 'Execution failed without details',
      });
    });

    it('suspended status returns success: false', () => {
      const result = toClientResponse({
        status: 'suspended',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'EXECUTION_FAILED',
        message: 'Execution failed without details',
      });
    });

    it('cancelled status with custom error preserves the error', () => {
      const result = toClientResponse({
        status: 'cancelled',
        error: { code: 'USER_CANCELLED', message: 'User cancelled the request' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'USER_CANCELLED',
        message: 'User cancelled the request',
      });
    });

    it('failed execution does not include resultData in response', () => {
      const result = toClientResponse({
        status: 'failed',
        error: { code: 'FLOW_STEP_ERROR', message: 'Step 3 failed' },
        resultData: { partialResponse: 'some data' },
      });

      expect(result.success).toBe(false);
      expect(result.response).toBe('');
      // resultData is not included when failed
      expect(result.resultData).toBeUndefined();
    });
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe('edge cases', () => {
    it('undefined status is treated as not-failed (success: true)', () => {
      const result = toClientResponse({
        response: 'Some response',
      });

      expect(result.success).toBe(true);
      expect(result.response).toBe('Some response');
      expect(result.error).toBeUndefined();
    });

    it('no fields at all returns success: true with empty response', () => {
      const result = toClientResponse({});

      expect(result).toEqual({
        success: true,
        response: '',
        resultData: undefined,
        error: undefined,
      });
    });

    it('resultData.response takes priority over resultData.text', () => {
      const result = toClientResponse({
        status: 'completed',
        resultData: { response: 'From response field', text: 'From text field' },
      });

      expect(result.response).toBe('From response field');
    });

    it('non-string resultData.response falls through to text', () => {
      const result = toClientResponse({
        status: 'completed',
        resultData: { response: 123 as unknown, text: 'Fallback text' },
      });

      expect(result.response).toBe('Fallback text');
    });

    it('non-string resultData.text falls through to empty string', () => {
      const result = toClientResponse({
        status: 'completed',
        resultData: { text: 42 as unknown },
      });

      expect(result.response).toBe('');
    });

    it('empty string top-level response falls through to resultData', () => {
      const result = toClientResponse({
        status: 'completed',
        response: '',
        resultData: { response: 'From resultData' },
      });

      // Empty string is falsy, so it falls through
      expect(result.response).toBe('From resultData');
    });

    it('resultData with extra fields is passed through on success', () => {
      const result = toClientResponse({
        status: 'completed',
        response: 'Hello',
        resultData: { voiceConfig: { speed: 1.2 }, actions: ['save'] },
      });

      expect(result.resultData).toEqual({ voiceConfig: { speed: 1.2 }, actions: ['save'] });
    });
  });
});
