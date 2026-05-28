/**
 * ABLP-1059 Reproduction Test — A2A Handoff Mode Resolution
 *
 * FAILS: reproduces ABLP-1059
 *
 * These tests exercise the 4-row truth table for mode selection:
 *   1. ASYNC:false + streaming:false  -> sync
 *   2. ASYNC:false + streaming:true   -> streaming
 *   3. ASYNC:true  + push:true        -> async-push
 *   4. ASYNC:true  + push:false       -> error (fast-fail)
 *
 * These tests exercise the current routing-executor decision extracted into a
 * pure helper. They assert the target contract and fail where current routing
 * silently falls back or ignores remote push capability.
 *
 * Once a proper A2AModeResolver is implemented and exported from
 * @agent-platform/a2a, these tests will pass.
 */

// FAILS: reproduces ABLP-1059

import { describe, it, expect } from 'vitest';
import type { AgentCard } from '@a2a-js/sdk';
import { resolveCurrentA2AHandoffMode } from '../../../../apps/runtime/src/services/execution/routing-executor.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

function makeAgentCard(overrides: Partial<AgentCard['capabilities']> = {}): AgentCard {
  return {
    name: 'Test Remote Agent',
    description: 'Agent for mode resolution tests',
    url: 'https://remote-agent.example.com/a2a',
    version: '1.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      ...overrides,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  };
}

function resolveA2AMode(input: {
  dslAsync: boolean;
  agentCard: AgentCard | null;
  asyncInfraAvailable: boolean;
  userConnected: boolean;
}) {
  return resolveCurrentA2AHandoffMode({
    dslAsync: input.dslAsync,
    asyncInfraAvailable: input.asyncInfraAvailable,
    userConnected: input.userConnected,
    remoteSupportsStreaming: input.agentCard?.capabilities?.streaming === true,
    remoteSupportsPushNotifications: input.agentCard?.capabilities?.pushNotifications === true,
  });
}

// =============================================================================
// MODE RESOLUTION TRUTH TABLE
// =============================================================================

describe('resolveA2AMode — ABLP-1059 truth table', () => {
  it('row 1: ASYNC:false + streaming:false -> sync', () => {
    const result = resolveA2AMode({
      dslAsync: false,
      agentCard: makeAgentCard({ streaming: false, pushNotifications: false }),
      asyncInfraAvailable: true,
      userConnected: true,
    });

    expect(result.mode).toBe('sync');
  });

  it('row 2: ASYNC:false + streaming:true + userConnected -> streaming', () => {
    const result = resolveA2AMode({
      dslAsync: false,
      agentCard: makeAgentCard({ streaming: true, pushNotifications: false }),
      asyncInfraAvailable: true,
      userConnected: true,
    });

    expect(result.mode).toBe('streaming');
  });

  it('row 2b: ASYNC:false + streaming:true + userNotConnected -> sync (no streaming without user)', () => {
    const result = resolveA2AMode({
      dslAsync: false,
      agentCard: makeAgentCard({ streaming: true, pushNotifications: false }),
      asyncInfraAvailable: true,
      userConnected: false,
    });

    expect(result.mode).toBe('sync');
  });

  it('row 3: ASYNC:true + push:true + asyncInfra:true -> async-push', () => {
    const result = resolveA2AMode({
      dslAsync: true,
      agentCard: makeAgentCard({ streaming: true, pushNotifications: true }),
      asyncInfraAvailable: true,
      userConnected: true,
    });

    expect(result.mode).toBe('async-push');
  });

  it('row 4: ASYNC:true + push:false -> ERROR (fast-fail, no silent fallback)', () => {
    expect(() =>
      resolveA2AMode({
        dslAsync: true,
        agentCard: makeAgentCard({ streaming: true, pushNotifications: false }),
        asyncInfraAvailable: true,
        userConnected: true,
      }),
    ).toThrow(/push/i);
  });

  it('ASYNC:true + asyncInfra:false -> ERROR (infra not available)', () => {
    expect(() =>
      resolveA2AMode({
        dslAsync: true,
        agentCard: makeAgentCard({ streaming: true, pushNotifications: true }),
        asyncInfraAvailable: false,
        userConnected: true,
      }),
    ).toThrow(/async.*infra|infra.*not.*available/i);
  });

  it('ASYNC:true + agentCard:null -> ERROR (cannot verify push capability)', () => {
    expect(() =>
      resolveA2AMode({
        dslAsync: true,
        agentCard: null,
        asyncInfraAvailable: true,
        userConnected: true,
      }),
    ).toThrow(/push/i);
  });

  it('mode result includes reason string for trace observability', () => {
    const result = resolveA2AMode({
      dslAsync: false,
      agentCard: makeAgentCard({ streaming: true }),
      asyncInfraAvailable: true,
      userConnected: true,
    });

    expect(result).toHaveProperty('reason');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
