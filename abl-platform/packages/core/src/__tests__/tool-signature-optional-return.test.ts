import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';
import { parseToolFile } from '../parser/tool-file-parser.js';

describe('tool signature optional return type regression', () => {
  it('keeps agent TOOLS entries instead of silently dropping them', () => {
    const dsl = `AGENT: RefundAgent
GOAL: "Help customers check refund eligibility"

TOOLS:
  check_refund_eligibility(order_id: string)
    description: "Look up refund eligibility for an order"
    type: http
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.document?.tools).toHaveLength(1);

    const tool = result.document!.tools[0];
    expect(tool.name).toBe('check_refund_eligibility');
    expect(tool.parameters).toHaveLength(1);
    expect(tool.parameters[0].name).toBe('order_id');
    expect(tool.parameters[0].type).toBe('string');
    expect(tool.parameters[0].required).toBe(true);
    expect(tool.returns.type).toBe('object');
    expect(tool.description).toBe('Look up refund eligibility for an order');
    expect(tool.type).toBe('http');
  });

  it('defaults standalone .tools.abl signatures to object too', () => {
    const dsl = `TOOLS:
  check_refund_eligibility(order_id: string)
    description: "Look up refund eligibility for an order"
    type: http
`;

    const result = parseToolFile(dsl);

    expect(result.errors).toEqual([]);
    expect(result.document?.tools).toHaveLength(1);

    const tool = result.document!.tools[0];
    expect(tool.name).toBe('check_refund_eligibility');
    expect(tool.parameters).toHaveLength(1);
    expect(tool.parameters[0].name).toBe('order_id');
    expect(tool.parameters[0].type).toBe('string');
    expect(tool.parameters[0].required).toBe(true);
    expect(tool.returns.type).toBe('object');
    expect(tool.description).toBe('Look up refund eligibility for an order');
    expect(tool.type).toBe('http');
  });

  it('reports invalid dotted agent TOOLS signatures instead of silently dropping them', () => {
    const dsl = `AGENT: RefundAgent
GOAL: "Help customers check refund eligibility"

TOOLS:
  payments.check_refund_eligibility(order_id: string)
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document?.tools).toEqual([]);
    expect(result.errors.map((error) => error.message)).toContain(
      `Invalid tool signature 'payments.check_refund_eligibility(order_id: string)'. Use a tool name made of letters, numbers, and underscores, for example payments__check_refund_eligibility(...).`,
    );
  });

  it('reports invalid dotted standalone .tools.abl signatures too', () => {
    const dsl = `TOOLS:
  payments.check_refund_eligibility(order_id: string)
`;

    const result = parseToolFile(dsl);

    expect(result.document?.tools).toEqual([]);
    expect(result.errors.map((error) => error.message)).toContain(
      `Invalid tool signature 'payments.check_refund_eligibility(order_id: string)'. Use a tool name made of letters, numbers, and underscores, for example payments__check_refund_eligibility(...).`,
    );
  });
});
