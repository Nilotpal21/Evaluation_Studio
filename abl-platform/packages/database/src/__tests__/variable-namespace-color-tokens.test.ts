import { describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  VariableNamespace,
  VARIABLE_NAMESPACE_COLOR_TOKENS,
  isValidNamespaceColor,
} from '../models/variable-namespace.model.js';

/**
 * Canonical namespace color tokens. Must mirror NAMESPACE_COLOR_TOKENS exported
 * from @agent-platform/design-tokens. A sibling test in that package pins the
 * same list — drift on either side fails its own test.
 *
 * Regression coverage for ABLP-633: the UI palette switched to themeable
 * `hsl(var(--…))` strings but the model validator still required 6-digit hex,
 * causing every "Create namespace" click to fall through to a generic 500.
 */
const CANONICAL_TOKENS = ['accent', 'success', 'warning', 'purple', 'info', 'error', 'orange'];

describe('VariableNamespace color contract', () => {
  test('model exports the canonical token list', () => {
    expect([...VARIABLE_NAMESPACE_COLOR_TOKENS]).toEqual(CANONICAL_TOKENS);
  });

  test('every canonical token passes isValidNamespaceColor', () => {
    for (const token of CANONICAL_TOKENS) {
      expect(isValidNamespaceColor(token)).toBe(true);
    }
  });

  test('schema validator accepts each canonical token without throwing', async () => {
    for (const token of CANONICAL_TOKENS) {
      const doc = new VariableNamespace({
        tenantId: 't1',
        projectId: 'p1',
        name: `ns-${token}`,
        displayName: token,
        color: token,
        createdBy: 'test',
      });
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });

  test('schema validator accepts legacy 6-digit hex for backwards compatibility', async () => {
    const doc = new VariableNamespace({
      tenantId: 't1',
      projectId: 'p1',
      name: 'legacy-hex',
      displayName: 'Legacy',
      color: '#1a2b3c',
      createdBy: 'test',
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  test('schema validator accepts null color', async () => {
    const doc = new VariableNamespace({
      tenantId: 't1',
      projectId: 'p1',
      name: 'no-color',
      displayName: 'No color',
      color: null,
      createdBy: 'test',
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  test('validator rejection message stays compatible with runtime route tests', async () => {
    const doc = new VariableNamespace({
      tenantId: 't1',
      projectId: 'p1',
      name: 'msg-shape',
      displayName: 'Msg',
      color: 'red',
      createdBy: 'test',
    });
    await expect(doc.validate()).rejects.toThrow(/hex color/);
  });

  test('schema validator rejects CSS-var strings (the ABLP-633 failure mode)', async () => {
    const doc = new VariableNamespace({
      tenantId: 't1',
      projectId: 'p1',
      name: 'bad-css-var',
      displayName: 'Bad',
      color: 'hsl(var(--accent))',
      createdBy: 'test',
    });
    await expect(doc.validate()).rejects.toThrow(mongoose.Error.ValidationError);
  });

  test.each([
    ['empty string', ''],
    ['short hex', '#abc'],
    ['rgba', 'rgba(0,0,0,1)'],
    ['unknown token', 'magenta'],
    ['8-digit hex with alpha', '#1a2b3c4d'],
  ])('schema validator rejects %s', async (_label, color) => {
    const doc = new VariableNamespace({
      tenantId: 't1',
      projectId: 'p1',
      name: `bad-${_label.replace(/\s+/g, '-')}`,
      displayName: 'Bad',
      color,
      createdBy: 'test',
    });
    await expect(doc.validate()).rejects.toThrow(mongoose.Error.ValidationError);
  });
});
