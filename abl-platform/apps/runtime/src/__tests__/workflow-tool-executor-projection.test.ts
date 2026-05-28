/**
 * INT-13 — Positive-list projection verification.
 *
 * Drives the projection helpers `buildAgentSessionProjection` and
 * `buildAgentContextProjection` with synthetic input that includes EXTRA
 * fields (creditCardLast4, modelId, internalDebugFlag) and asserts those
 * fields are NOT present on the returned wire shapes. Confirms the §9
 * privacy-by-default invariant: workflows only see fields the projection
 * explicitly enumerates.
 *
 * Pure function tests — no HTTP, no isolate, no DB. The projection
 * helpers are the emit-side guard; the workflow-engine materializer is
 * the receive-side guard. Both must reject extras independently.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAgentContextProjection,
  buildAgentSessionProjection,
  type AgentContextProjectionInput,
  type AgentSessionProjectionInput,
} from '../services/workflow/workflow-tool-executor.js';
import { resolveAgentSessionProjection } from '../services/workflow/agent-session-resolver.js';

describe('INT-13 — agentSession positive-list filter', () => {
  it('strips unrecognized top-level fields', () => {
    // Cast through unknown to allow extra fields on the input.
    const malicious = {
      sessionId: 'sess-1',
      agentName: 'sales',
      channel: 'web',
      source: 'public',
      endUserId: 'u-42',
      locale: 'en-US',
      startedAt: '2026-04-27T12:00:00Z',
      lastActivityAt: '2026-04-27T12:05:00Z',
      // EXTRAS — must be stripped:
      creditCardLast4: '4242',
      modelId: 'gpt-5',
      internalDebugFlag: true,
      _v: 7,
    } as unknown as AgentSessionProjectionInput;

    const result = buildAgentSessionProjection(malicious);
    expect(result).toBeDefined();
    expect(Object.keys(result!).sort()).toEqual([
      'agentName',
      'channel',
      'endUserId',
      'lastActivityAt',
      'locale',
      'sessionId',
      'source',
      'startedAt',
    ]);
    expect((result as Record<string, unknown>).creditCardLast4).toBeUndefined();
    expect((result as Record<string, unknown>).modelId).toBeUndefined();
    expect((result as Record<string, unknown>).internalDebugFlag).toBeUndefined();
    expect((result as Record<string, unknown>)._v).toBeUndefined();
  });

  it('returns undefined when input is undefined (agent-less path)', () => {
    expect(buildAgentSessionProjection(undefined)).toBeUndefined();
  });
});

describe('INT-13 — agentContext positive-list filter', () => {
  it('strips extras from caller, invocation, attachments, messageMetadata', () => {
    const malicious = {
      caller: {
        type: 'agent',
        id: 'sales-agent',
        // EXTRA — must be stripped:
        internalRole: 'admin',
        sourceIp: '10.0.0.1',
      },
      attachments: [
        {
          id: 'att-1',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          name: 'quote.pdf',
          // EXTRAS — must be stripped:
          rawBytes: 'BASE64DATA',
          virusScanReport: { clean: true },
        },
      ],
      messageMetadata: {
        correlationId: 'corr-1',
        // safe to forward — generic record:
        userIntent: 'purchase',
      },
    } as unknown as AgentContextProjectionInput;

    const result = buildAgentContextProjection(
      'sendQuote',
      { amount: 100, currency: 'USD' },
      malicious,
    );
    expect(result).toBeDefined();

    // Caller is positive-list.
    expect(Object.keys(result!.caller).sort()).toEqual(['id', 'type']);
    expect((result!.caller as Record<string, unknown>).internalRole).toBeUndefined();
    expect((result!.caller as Record<string, unknown>).sourceIp).toBeUndefined();

    // Invocation is positive-list. `args` is the per-call params.
    expect(Object.keys(result!.invocation).sort()).toEqual(['args', 'tool']);
    expect(result!.invocation.tool).toBe('sendQuote');
    expect(result!.invocation.args).toEqual({ amount: 100, currency: 'USD' });

    // Attachments — each item is reconstructed field-by-field.
    expect(result!.attachments).toHaveLength(1);
    const att = result!.attachments[0];
    expect(Object.keys(att).sort()).toEqual(['id', 'mimeType', 'name', 'sizeBytes']);
    expect((att as Record<string, unknown>).rawBytes).toBeUndefined();
    expect((att as Record<string, unknown>).virusScanReport).toBeUndefined();

    // Message metadata is forwarded as-is (intentionally generic) but is
    // a SHALLOW COPY of the input — mutating the input shouldn't poison
    // the projection (regression: prevent reference-aliasing leaks).
    const inputMeta = malicious.messageMetadata!;
    inputMeta.correlationId = 'corr-MUTATED';
    expect(result!.messageMetadata?.correlationId).toBe('corr-1');
  });

  it('returns undefined when input is undefined', () => {
    expect(buildAgentContextProjection('toolX', { foo: 'bar' }, undefined)).toBeUndefined();
  });
});

describe('INT-13 — resolveAgentSessionProjection (Studio→studio-debug + endUserId derivation)', () => {
  it('translates Studio sessions into source=studio-debug with endUserId undefined', () => {
    const result = resolveAgentSessionProjection({
      sessionId: 'sess-studio',
      agentName: 'sales',
      callerContext: {
        tenantId: 't1',
        channel: 'web_debug',
        initiatedById: 'workspace-user-7',
        identityTier: 0,
        verificationMethod: 'none',
      },
      channelType: 'web_debug',
      startedAt: '2026-04-27T12:00:00Z',
      lastActivityAt: '2026-04-27T12:05:00Z',
    });
    expect(result?.source).toBe('studio-debug');
    expect(result?.endUserId).toBeUndefined();
  });

  it('translates Public sessions and surfaces customerId as endUserId', () => {
    const result = resolveAgentSessionProjection({
      sessionId: 'sess-public',
      agentName: 'sales',
      callerContext: {
        tenantId: 't1',
        channel: 'web',
        customerId: 'cust-42',
        identityTier: 1,
        verificationMethod: 'none',
      },
      channelType: 'web',
      startedAt: '2026-04-27T12:00:00Z',
      lastActivityAt: '2026-04-27T12:05:00Z',
    });
    expect(result?.source).toBe('public');
    expect(result?.endUserId).toBe('cust-42');
  });

  it('translates Channel sessions with channelId + endUserId', () => {
    const result = resolveAgentSessionProjection({
      sessionId: 'sess-channel',
      agentName: 'sales',
      callerContext: {
        tenantId: 't1',
        channel: 'voice',
        channelId: 'ch-twilio-1',
        anonymousId: 'anon-9',
        identityTier: 0,
        verificationMethod: 'none',
      },
      channelType: 'voice',
      startedAt: '2026-04-27T12:00:00Z',
      lastActivityAt: '2026-04-27T12:05:00Z',
    });
    expect(result?.source).toBe('channel');
    expect(result?.endUserId).toBe('anon-9');
  });

  it('returns undefined when channel cannot be derived', () => {
    const result = resolveAgentSessionProjection({
      sessionId: 'sess-nochan',
      agentName: 'sales',
      startedAt: '2026-04-27T12:00:00Z',
      lastActivityAt: '2026-04-27T12:05:00Z',
    });
    expect(result).toBeUndefined();
  });
});
