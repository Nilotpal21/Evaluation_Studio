import { describe, expect, it } from 'vitest';
import {
  buildHumanOutputSchema,
  parseFunctionOutputSchema,
} from '../useWorkflowExpressionContext.js';

describe('buildHumanOutputSchema', () => {
  it('always emits respondedBy and decision (engine-fixed fields)', () => {
    const schema = buildHumanOutputSchema(undefined);
    const response = (schema as { humanTaskResponse: Record<string, unknown> }).humanTaskResponse;

    expect(response.respondedBy).toBe('string');
    expect(response.decision).toBe('string');
  });

  it('falls back to generic object for fields when no fields configured', () => {
    const schema = buildHumanOutputSchema(undefined);
    const response = (schema as { humanTaskResponse: Record<string, unknown> }).humanTaskResponse;

    expect(response.fields).toBe('object');
  });

  it('derives fields schema from configured node fields', () => {
    const schema = buildHumanOutputSchema({
      fields: [
        { name: 'customerName', type: 'text' },
        { name: 'priority', type: 'select' },
        { name: 'budget', type: 'number' },
        { name: 'urgent', type: 'boolean' },
      ],
    });
    const fields = (schema as { humanTaskResponse: { fields: Record<string, string> } })
      .humanTaskResponse.fields;

    expect(fields.customerName).toBe('string');
    expect(fields.priority).toBe('string');
    expect(fields.budget).toBe('number');
    expect(fields.urgent).toBe('boolean');
  });

  it('skips fields with missing or empty names', () => {
    const schema = buildHumanOutputSchema({
      fields: [
        { name: 'valid', type: 'text' },
        { name: '', type: 'text' },
        { name: '   ', type: 'text' },
        { type: 'text' }, // missing name
        { name: 'another', type: 'number' },
      ],
    });
    const fields = (schema as { humanTaskResponse: { fields: Record<string, string> } })
      .humanTaskResponse.fields;

    expect(Object.keys(fields)).toEqual(['valid', 'another']);
  });

  it('defaults unknown field types to string', () => {
    const schema = buildHumanOutputSchema({
      fields: [
        { name: 'asDate', type: 'date' },
        { name: 'asTextarea', type: 'textarea' },
        { name: 'asMystery', type: 'unknown-type' },
      ],
    });
    const fields = (schema as { humanTaskResponse: { fields: Record<string, string> } })
      .humanTaskResponse.fields;

    expect(fields.asDate).toBe('string');
    expect(fields.asTextarea).toBe('string');
    expect(fields.asMystery).toBe('string');
  });

  it('does NOT emit notes or respondedAt — these are hidden from authoring', () => {
    const schema = buildHumanOutputSchema({
      fields: [{ name: 'note', type: 'text' }],
    });
    const response = (schema as { humanTaskResponse: Record<string, unknown> }).humanTaskResponse;

    expect(response).not.toHaveProperty('notes');
    expect(response).not.toHaveProperty('respondedAt');
  });

  it('handles config with non-array fields gracefully', () => {
    const schema = buildHumanOutputSchema({ fields: 'not an array' });
    const fields = (schema as { humanTaskResponse: { fields: unknown } }).humanTaskResponse.fields;

    expect(fields).toBe('object');
  });
});

describe('parseFunctionOutputSchema', () => {
  it('extracts the keys the ticket repro writes (ABLP-1086 follow-up)', () => {
    const code = `
      context.product_name = "Widget";
      context.eligible = true;
      context.is_high_value = false;
    `;
    const schema = parseFunctionOutputSchema(code);
    expect(schema).toEqual({ product_name: 'any', eligible: 'any', is_high_value: 'any' });
  });

  it('returns undefined for empty / falsy code so the explorer falls back to single-leaf', () => {
    expect(parseFunctionOutputSchema('')).toBeUndefined();
    expect(parseFunctionOutputSchema(undefined)).toBeUndefined();
    expect(parseFunctionOutputSchema('// just a comment\nconst x = 1;')).toBeUndefined();
  });

  it('ignores equality and strict-equality reads', () => {
    // Plain `==` and `===` should NOT be treated as writes. Without the
    // negative lookahead this would falsely capture `value` as a written key.
    const code = `if (context.value == 1) {}\nif (context.other === "x") {}`;
    expect(parseFunctionOutputSchema(code)).toBeUndefined();
  });

  it('ignores chained reads like context.trigger.payload.x', () => {
    const code = 'const id = context.trigger.payload.orderId;\nconst u = context.steps.A.output;';
    expect(parseFunctionOutputSchema(code)).toBeUndefined();
  });

  it('filters engine-reserved top-level names (trigger, steps, workflow, tenant, vars, memory, agentSession, agentContext)', () => {
    // These can't be written to (function-executor blocks them); even if a
    // user typed `context.trigger = ...`, it would throw at runtime. We
    // must not surface them as discoverable output fields.
    const code = `
      context.trigger = 1;
      context.steps = 2;
      context.workflow = 3;
      context.tenant = 4;
      context.vars = 5;
      context.memory = 6;
      context.agentSession = 7;
      context.agentContext = 8;
      context.real_field = 9;
    `;
    expect(parseFunctionOutputSchema(code)).toEqual({ real_field: 'any' });
  });

  it('dedupes when the same key is written multiple times', () => {
    const code = `
      context.count = 0;
      if (x) { context.count = 1; } else { context.count = 2; }
    `;
    expect(parseFunctionOutputSchema(code)).toEqual({ count: 'any' });
  });

  it('captures keys written across conditional branches', () => {
    // Static analysis can't know which branch fires, so we surface both —
    // matches how the user thinks about the function's possible outputs.
    const code = `
      if (eligible) {
        context.approval_status = "approved";
      } else {
        context.rejection_reason = "ineligible";
      }
    `;
    expect(parseFunctionOutputSchema(code)).toEqual({
      approval_status: 'any',
      rejection_reason: 'any',
    });
  });

  it('does not crash on computed-key writes (limitation, returns nothing for them)', () => {
    // `context[name] = ...` can't be statically resolved. The parser should
    // skip it cleanly and not throw.
    const code = `
      const k = "dynamic";
      context[k] = 1;
      context.known = 2;
    `;
    expect(parseFunctionOutputSchema(code)).toEqual({ known: 'any' });
  });

  it('ignores nested writes without an accompanying top-level assignment', () => {
    // `context.user.email = ...` only mutates an existing `user` object — the
    // function isn't producing `user` from this code. If we surfaced `user`
    // here, the Explorer would misleadingly imply this function outputs it.
    // The correct source of `user` is whichever upstream step or earlier
    // assignment actually created the object. Once a run lands, the live
    // executionContext path surfaces the real shape.
    const code = `context.user.email = "a@b"; context.user.name = "Anne";`;
    expect(parseFunctionOutputSchema(code)).toBeUndefined();
  });

  it('captures top-level only when both the parent assignment AND nested writes appear', () => {
    // The function explicitly seeds `user` as an object, then mutates it.
    // We surface `user` (from the seed assignment) but not its nested fields.
    const code = `
      context.user = {};
      context.user.email = "a@b";
      context.user.name = "Anne";
    `;
    expect(parseFunctionOutputSchema(code)).toEqual({ user: 'any' });
  });

  it('tolerates non-string inputs without throwing', () => {
    // Defensive: in case config.code is somehow not a string (older state,
    // migration leftovers), don't crash.
    expect(() => parseFunctionOutputSchema(null as unknown as string)).not.toThrow();
    expect(() => parseFunctionOutputSchema(42 as unknown as string)).not.toThrow();
    expect(parseFunctionOutputSchema(null as unknown as string)).toBeUndefined();
  });
});
