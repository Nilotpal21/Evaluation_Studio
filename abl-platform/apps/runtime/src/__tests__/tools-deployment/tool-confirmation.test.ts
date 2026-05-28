import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSnapshot,
  validateImmutability,
  formatConfirmationMessage,
  isSnapshotExpired,
  shouldRequireConfirmation,
  evaluateConversationConsent,
  shouldBlockForMissingConversationConsent,
  type ToolConfirmationSnapshot,
} from '../../services/execution/tool-confirmation.js';
import type { ToolDefinition, GatherField } from '@abl/compiler';

describe('Tool Confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createSnapshot', () => {
    test('creates snapshot with immutable params hashed', () => {
      const snap = createSnapshot(
        {
          id: 'tc-1',
          name: 'process_refund',
          input: { order_id: 'ORD-123', amount: 49.99, reason: 'defective' },
        },
        { require: 'always', immutable_params: ['order_id', 'amount'] },
      );
      expect(snap.toolName).toBe('process_refund');
      expect(snap.toolCallId).toBe('tc-1');
      expect(snap.params).toEqual({
        order_id: 'ORD-123',
        amount: 49.99,
        reason: 'defective',
      });
      expect(snap.immutableParams).toEqual(['order_id', 'amount']);
      expect(snap.snapshotHash).toBeTruthy();
      expect(snap.createdAt).toBe(Date.now());
      expect(snap.expiresAt).toBeGreaterThan(Date.now());
    });

    test('empty immutable_params when not specified', () => {
      const snap = createSnapshot(
        { id: 'tc-2', name: 'update', input: { name: 'Alice' } },
        { require: 'always' },
      );
      expect(snap.immutableParams).toEqual([]);
    });

    test('binds consent scope fields into the immutable snapshot', () => {
      const snap = createSnapshot(
        {
          id: 'tc-scope',
          name: 'issue_refund',
          input: { order_id: 'ORD-123', refund_amount: 49.99 },
        },
        {
          require: 'always',
          immutable_params: ['order_id'],
          consent_scope: ['order_id', 'refund_amount'],
        },
      );

      expect(snap.immutableParams).toEqual(['order_id', 'refund_amount']);
      expect(
        validateImmutability(snap, {
          order_id: 'ORD-123',
          refund_amount: 59.99,
        }),
      ).toEqual({ valid: false, violations: ['refund_amount'] });
    });

    test('hash is deterministic for same values', () => {
      const s1 = createSnapshot(
        { id: 'tc-1', name: 'r', input: { a: 'A', b: 10 } },
        { require: 'always', immutable_params: ['a', 'b'] },
      );
      const s2 = createSnapshot(
        { id: 'tc-2', name: 'r', input: { a: 'A', b: 10 } },
        { require: 'always', immutable_params: ['a', 'b'] },
      );
      expect(s1.snapshotHash).toBe(s2.snapshotHash);
    });

    test('hash changes when immutable param changes', () => {
      const s1 = createSnapshot(
        { id: 'tc-1', name: 'r', input: { a: 'A', b: 10 } },
        { require: 'always', immutable_params: ['a', 'b'] },
      );
      const s2 = createSnapshot(
        { id: 'tc-2', name: 'r', input: { a: 'A', b: 99 } },
        { require: 'always', immutable_params: ['a', 'b'] },
      );
      expect(s1.snapshotHash).not.toBe(s2.snapshotHash);
    });
  });

  describe('validateImmutability', () => {
    test('passes when immutable params unchanged', () => {
      const snap: ToolConfirmationSnapshot = {
        toolName: 'r',
        toolCallId: 'tc-1',
        params: { order_id: 'ORD-123', amount: 49.99, reason: 'defective' },
        immutableParams: ['order_id', 'amount'],
        snapshotHash: 'h',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
      expect(
        validateImmutability(snap, {
          order_id: 'ORD-123',
          amount: 49.99,
          reason: 'changed',
        }).valid,
      ).toBe(true);
    });

    test('fails when immutable param changed', () => {
      const snap: ToolConfirmationSnapshot = {
        toolName: 'r',
        toolCallId: 'tc-1',
        params: { order_id: 'ORD-123', amount: 49.99 },
        immutableParams: ['order_id', 'amount'],
        snapshotHash: 'h',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
      const result = validateImmutability(snap, {
        order_id: 'ORD-123',
        amount: 999,
      });
      expect(result.valid).toBe(false);
      expect(result.violations).toContain('amount');
    });

    test('fails when immutable param removed', () => {
      const snap: ToolConfirmationSnapshot = {
        toolName: 'r',
        toolCallId: 'tc-1',
        params: { order_id: 'ORD-123', amount: 49.99 },
        immutableParams: ['order_id', 'amount'],
        snapshotHash: 'h',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
      expect(validateImmutability(snap, { order_id: 'ORD-123' }).violations).toContain('amount');
    });

    test('passes with empty immutableParams', () => {
      const snap: ToolConfirmationSnapshot = {
        toolName: 'u',
        toolCallId: 'tc-1',
        params: { name: 'Alice' },
        immutableParams: [],
        snapshotHash: 'h',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
      expect(validateImmutability(snap, { name: 'Bob' }).valid).toBe(true);
    });

    test('deep equality for nested objects', () => {
      const snap: ToolConfirmationSnapshot = {
        toolName: 'o',
        toolCallId: 'tc-1',
        params: { items: [{ sku: 'A', qty: 2 }] },
        immutableParams: ['items'],
        snapshotHash: 'h',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
      expect(validateImmutability(snap, { items: [{ sku: 'A', qty: 2 }] }).valid).toBe(true);
    });
  });

  describe('isSnapshotExpired', () => {
    test('returns false when fresh', () => {
      const snap: ToolConfirmationSnapshot = {
        toolName: 'r',
        toolCallId: 'tc-1',
        params: {},
        immutableParams: [],
        snapshotHash: 'h',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
      expect(isSnapshotExpired(snap)).toBe(false);
    });

    test('returns true when expired', () => {
      const snap: ToolConfirmationSnapshot = {
        toolName: 'r',
        toolCallId: 'tc-1',
        params: {},
        immutableParams: [],
        snapshotHash: 'h',
        createdAt: Date.now() - 600_000,
        expiresAt: Date.now() - 300_000,
      };
      expect(isSnapshotExpired(snap)).toBe(true);
    });
  });

  describe('formatConfirmationMessage', () => {
    test('includes tool name and params', () => {
      const msg = formatConfirmationMessage(
        {
          id: 'tc-1',
          name: 'process_refund',
          input: { order_id: 'ORD-123', amount: 49.99 },
        },
        { require: 'always', immutable_params: ['order_id', 'amount'] },
      );
      expect(msg).toContain('process_refund');
      expect(msg).toContain('order_id');
      expect(msg).toContain('49.99');
    });

    test('masks sensitive values with redact mode', () => {
      const gatherFields: GatherField[] = [
        {
          name: 'ssn',
          prompt: 'SSN?',
          type: 'string',
          required: true,
          sensitive: true,
          sensitive_display: 'redact',
        },
        { name: 'name', prompt: 'Name?', type: 'string', required: true },
      ];
      const msg = formatConfirmationMessage(
        { id: 'tc-1', name: 'verify_identity', input: { ssn: '123-45-6789', name: 'Alice' } },
        { require: 'always' },
        gatherFields,
      );
      expect(msg).toContain('[REDACTED]');
      expect(msg).not.toContain('123-45-6789');
      expect(msg).toContain('Alice');
    });

    test('masks sensitive values with mask mode', () => {
      const gatherFields: GatherField[] = [
        {
          name: 'card_number',
          prompt: 'Card?',
          type: 'string',
          required: true,
          sensitive: true,
          sensitive_display: 'mask',
          mask_config: { show_first: 0, show_last: 4, char: '*' },
        },
      ];
      const msg = formatConfirmationMessage(
        { id: 'tc-1', name: 'charge_card', input: { card_number: '4111111111111111' } },
        { require: 'always' },
        gatherFields,
      );
      expect(msg).toContain('************1111');
      expect(msg).not.toContain('4111111111111111');
    });

    test('masks sensitive values with replace mode', () => {
      const gatherFields: GatherField[] = [
        {
          name: 'api_key',
          prompt: 'Key?',
          type: 'string',
          required: true,
          sensitive: true,
          sensitive_display: 'replace',
        },
      ];
      const msg = formatConfirmationMessage(
        { id: 'tc-1', name: 'set_key', input: { api_key: 'sk-abc123secret' } },
        { require: 'always' },
        gatherFields,
      );
      expect(msg).toContain('[API_KEY]');
      expect(msg).not.toContain('sk-abc123secret');
    });

    test('non-sensitive fields display normally with gatherFields provided', () => {
      const gatherFields: GatherField[] = [
        { name: 'email', prompt: 'Email?', type: 'string', required: true },
      ];
      const msg = formatConfirmationMessage(
        { id: 'tc-1', name: 'send', input: { email: 'alice@example.com' } },
        { require: 'always' },
        gatherFields,
      );
      expect(msg).toContain('"alice@example.com"');
    });

    test('backward compatible without gatherFields', () => {
      const msg = formatConfirmationMessage(
        { id: 'tc-1', name: 'send', input: { secret: 'plaintext' } },
        { require: 'always' },
      );
      expect(msg).toContain('"plaintext"');
    });
  });

  describe('shouldRequireConfirmation', () => {
    test('true for always', () => {
      expect(
        shouldRequireConfirmation({
          confirmation: { require: 'always' },
          hints: {
            side_effects: false,
            cacheable: true,
            latency: 'fast',
            parallelizable: true,
            requires_auth: false,
          },
        } as ToolDefinition),
      ).toBe(true);
    });

    test('true for when_side_effects + side_effects true', () => {
      expect(
        shouldRequireConfirmation({
          confirmation: { require: 'when_side_effects' },
          hints: {
            side_effects: true,
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            requires_auth: true,
          },
        } as ToolDefinition),
      ).toBe(true);
    });

    test('false for when_side_effects + side_effects false', () => {
      expect(
        shouldRequireConfirmation({
          confirmation: { require: 'when_side_effects' },
          hints: {
            side_effects: false,
            cacheable: true,
            latency: 'fast',
            parallelizable: true,
            requires_auth: false,
          },
        } as ToolDefinition),
      ).toBe(false);
    });

    test('false for never', () => {
      expect(
        shouldRequireConfirmation({
          confirmation: { require: 'never' },
          hints: {
            side_effects: true,
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            requires_auth: true,
          },
        } as ToolDefinition),
      ).toBe(false);
    });

    test('false when no confirmation config', () => {
      expect(
        shouldRequireConfirmation({
          hints: {
            side_effects: true,
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            requires_auth: true,
          },
        } as ToolDefinition),
      ).toBe(false);
    });
  });

  describe('evaluateConversationConsent', () => {
    test('detects specific replacement consent for the same tool action', () => {
      const decision = evaluateConversationConsent(
        {
          id: 'tc-replacement',
          name: 'create_replacement',
          input: { order_id: 'VM-48217-A', shipping_speed: 'expedited' },
        },
        {
          require: 'when_side_effects',
          immutable_params: ['order_id'],
          consent_required_in: 'conversation',
          consent_scope: ['order_id'],
        },
        [
          { role: 'assistant', content: 'I can ship a replacement or issue a refund.' },
          { role: 'user', content: 'Replacement, please.' },
        ],
      );

      expect(decision).toEqual(
        expect.objectContaining({
          satisfied: true,
          reason: 'detected',
        }),
      );
      expect(decision.evidence?.matchedAction).toBe('replacement');
      expect(decision.evidence?.scopedFields).toEqual(['order_id']);
    });

    test('does not treat replacement consent as refund consent', () => {
      const decision = evaluateConversationConsent(
        {
          id: 'tc-refund',
          name: 'issue_refund',
          input: { order_id: 'VM-48217-A', amount: 349.99 },
        },
        {
          require: 'when_side_effects',
          immutable_params: ['order_id'],
          consent_required_in: 'conversation',
          consent_scope: ['order_id'],
        },
        [
          { role: 'assistant', content: 'I can ship a replacement or issue a refund.' },
          { role: 'user', content: 'Replacement, please.' },
        ],
      );

      expect(decision).toEqual({ satisfied: false, reason: 'missing' });
    });

    test('returns scope_mismatch when the user names a different scoped identifier', () => {
      const decision = evaluateConversationConsent(
        {
          id: 'tc-replacement',
          name: 'create_replacement',
          input: { order_id: 'VM-48217-A' },
        },
        {
          require: 'when_side_effects',
          immutable_params: ['order_id'],
          consent_required_in: 'conversation',
          consent_scope: ['order_id'],
        },
        [{ role: 'user', content: 'Replacement for VM-99999 please.' }],
      );

      expect(decision).toEqual({ satisfied: false, reason: 'scope_mismatch' });
    });

    test('returns scope_mismatch when the user names a different numeric scoped value', () => {
      const decision = evaluateConversationConsent(
        {
          id: 'tc-refund',
          name: 'issue_refund',
          input: { order_id: 'ORD-123', refund_amount: 49.99 },
        },
        {
          require: 'when_side_effects',
          immutable_params: ['order_id'],
          consent_required_in: 'conversation',
          consent_scope: ['order_id', 'refund_amount'],
          consent_action: 'refund',
        },
        [{ role: 'user', content: 'Please refund ORD-123 for $10.' }],
      );

      expect(decision).toEqual({ satisfied: false, reason: 'scope_mismatch' });
    });

    test('does not treat numeric portions of matched identifiers as amount consent', () => {
      const decision = evaluateConversationConsent(
        {
          id: 'tc-refund',
          name: 'issue_refund',
          input: { order_id: 'ORD-123', refund_amount: 49.99 },
        },
        {
          require: 'when_side_effects',
          immutable_params: ['order_id'],
          consent_required_in: 'conversation',
          consent_scope: ['order_id', 'refund_amount'],
          consent_action: 'refund',
        },
        [{ role: 'user', content: 'Please refund order ORD-123.' }],
      );

      expect(decision).toEqual(
        expect.objectContaining({
          satisfied: true,
          reason: 'detected',
        }),
      );
    });

    test('falls back to explicit prompt when conversation consent is not configured', () => {
      const decision = evaluateConversationConsent(
        {
          id: 'tc-replacement',
          name: 'create_replacement',
          input: { order_id: 'VM-48217-A' },
        },
        { require: 'when_side_effects', immutable_params: ['order_id'] },
        [{ role: 'user', content: 'Replacement, please.' }],
      );

      expect(decision).toEqual({ satisfied: false, reason: 'not_configured' });
    });

    test('honors block fallback only for missing configured conversation consent', () => {
      expect(
        shouldBlockForMissingConversationConsent(
          {
            require: 'when_side_effects',
            consent_required_in: 'conversation',
            consent_fallback: 'block',
          },
          { satisfied: false, reason: 'missing' },
        ),
      ).toBe(true);
      expect(
        shouldBlockForMissingConversationConsent(
          { require: 'when_side_effects', consent_fallback: 'block' },
          { satisfied: false, reason: 'not_configured' },
        ),
      ).toBe(false);
      expect(
        shouldBlockForMissingConversationConsent(
          {
            require: 'when_side_effects',
            consent_required_in: 'conversation',
            consent_fallback: 'explicit_prompt',
          },
          { satisfied: false, reason: 'missing' },
        ),
      ).toBe(false);
    });
  });
});
