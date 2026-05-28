import { describe, it, expect } from 'vitest';
import type { ExecutionConfig } from '../platform/ir/schema.js';

describe('ExecutionConfig concurrency fields', () => {
  it('accepts serial concurrency', () => {
    const config: ExecutionConfig = {
      // mode is deprecated — execution style derived from flow presence
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 3600000,
      },
      concurrency: 'serial',
    };
    expect(config.concurrency).toBe('serial');
  });

  it('accepts preemptive concurrency', () => {
    const config: ExecutionConfig = {
      // mode is deprecated — execution style derived from flow presence
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 3600000,
      },
      concurrency: 'preemptive',
    };
    expect(config.concurrency).toBe('preemptive');
  });

  it('accepts parallel concurrency with limits', () => {
    const config: ExecutionConfig = {
      // mode is deprecated — execution style derived from flow presence
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 3600000,
      },
      concurrency: 'parallel',
      max_queue_depth: 20,
      max_concurrent_messages: 5,
    };
    expect(config.concurrency).toBe('parallel');
    expect(config.max_queue_depth).toBe(20);
    expect(config.max_concurrent_messages).toBe(5);
  });

  it('concurrency is optional (defaults to serial at runtime)', () => {
    const config: ExecutionConfig = {
      // mode is deprecated — execution style derived from flow presence
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 3600000,
      },
    };
    expect(config.concurrency).toBeUndefined();
  });
});
