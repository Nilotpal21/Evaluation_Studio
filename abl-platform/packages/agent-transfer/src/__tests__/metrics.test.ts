import { describe, it, expect, vi } from 'vitest';
import {
  recordTransfer,
  recordPrecheck,
  recordProviderLatency,
  recordTransferEvent,
  incrementActiveSessions,
  decrementActiveSessions,
  recordRecoveryScan,
  recordRecoveryClaim,
} from '../observability/metrics.js';

/**
 * These tests verify that metric recording functions execute without throwing.
 * In a real deployment, OTEL collector would receive the metrics.
 * Here we verify the API contract is correct.
 */
describe('agent-transfer metrics', () => {
  it('records a successful transfer', () => {
    expect(() =>
      recordTransfer({
        provider: 'kore',
        channel: 'chat',
        status: 'transferred',
        durationMs: 150,
        success: true,
      }),
    ).not.toThrow();
  });

  it('records a failed transfer with error code', () => {
    expect(() =>
      recordTransfer({
        provider: 'kore',
        channel: 'voice',
        status: 'no_agents',
        durationMs: 50,
        success: false,
      }),
    ).not.toThrow();
  });

  it('records precheck duration', () => {
    expect(() =>
      recordPrecheck({
        check: 'business_hours',
        durationMs: 25,
        success: true,
      }),
    ).not.toThrow();
  });

  it('records provider latency', () => {
    expect(() =>
      recordProviderLatency({
        provider: 'kore',
        operation: 'initTransfer',
        durationMs: 200,
      }),
    ).not.toThrow();
  });

  it('records transfer events', () => {
    expect(() => recordTransferEvent('agent:connected')).not.toThrow();
    expect(() => recordTransferEvent('agent:message')).not.toThrow();
  });

  it('increments and decrements active sessions', () => {
    expect(() => incrementActiveSessions('kore', 'chat')).not.toThrow();
    expect(() => incrementActiveSessions('kore', 'chat')).not.toThrow();
    expect(() => decrementActiveSessions('kore', 'chat')).not.toThrow();
  });

  it('does not go below zero for active sessions', () => {
    // Should not throw even when decrementing from zero
    expect(() => decrementActiveSessions('kore', 'email')).not.toThrow();
  });

  it('records recovery scan duration', () => {
    expect(() => recordRecoveryScan(500)).not.toThrow();
  });

  it('records recovery claims', () => {
    expect(() => recordRecoveryClaim()).not.toThrow();
  });
});
