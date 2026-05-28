import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import {
  resolveCompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
} from '../services/execution/compaction-policy.js';
import { compressToolResult } from '../services/execution/tool-result-compressor.js';

describe('resolveCompactionPolicy', () => {
  it('returns platform defaults when no project or agent config', () => {
    const session = {
      agentIR: { execution: {}, tools: [] },
      _projectRuntimeConfig: {},
    };
    const policy = resolveCompactionPolicy(session as any);
    expect(policy).toEqual(DEFAULT_COMPACTION_POLICY);
  });

  it('agent-level overrides project-level', () => {
    const session = {
      agentIR: {
        execution: {
          compaction: {
            tool_results: { max_chars: 50_000 },
          },
        },
        tools: [],
      },
      _projectRuntimeConfig: {
        compaction: {
          tool_results: { max_chars: 80_000, keep_recent: 3 },
        },
      },
    };
    const policy = resolveCompactionPolicy(session as any);
    expect(policy.tool_results.max_chars).toBe(50_000); // agent wins
    expect(policy.tool_results.keep_recent).toBe(3); // project fills gap
    expect(policy.tool_results.strategy).toBe('summarize'); // default fills rest
  });

  it('collects tool-level essential_fields into policy', () => {
    const session = {
      agentIR: {
        execution: {},
        tools: [
          {
            name: 'product_search',
            compaction: { essential_fields: ['title', 'price', 'brand'] },
          },
          {
            name: 'crm_lookup',
            tool_type: 'mcp',
            compaction: { essential_fields: ['customerId', 'name'] },
          },
          { name: 'no_compaction_tool' },
        ],
      },
      _projectRuntimeConfig: {},
    };
    const policy = resolveCompactionPolicy(session as any);
    expect(policy.tool_results.essential_fields).toEqual({
      product_search: ['title', 'price', 'brand'],
      crm_lookup: ['customerId', 'name'],
    });
  });

  it('caches resolved policy on session', () => {
    const session = {
      agentIR: { execution: {}, tools: [] },
      _projectRuntimeConfig: {},
    } as any;
    const policy1 = resolveCompactionPolicy(session);
    const policy2 = resolveCompactionPolicy(session);
    expect(policy1).toBe(policy2); // same reference = cached
  });

  it('wires DSL compaction through compile, policy resolution, and tool-result compression', () => {
    const parsed = parseAgentBasedABL(`
AGENT: compaction_agent
GOAL: "Search hotels"

EXECUTION:
  compaction:
    tool_results:
      strategy: structured
      structured_threshold: 500
      max_description_length: 12
    prior_turns:
      strategy: placeholder
      assistant_preview_chars: 40

TOOLS:
  search_hotels(destination: string) -> object
    description: "Search hotels"
    compaction:
      essential_fields: [name, price, description]
      max_description_length: 12
`);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.document).not.toBeNull();

    const output = compileABLtoIR([parsed.document!]);
    const agentIR = output.agents.compaction_agent;
    const policy = resolveCompactionPolicy({
      agentIR,
      _projectRuntimeConfig: {},
    } as any);

    expect(policy.tool_results.strategy).toBe('structured');
    expect(policy.tool_results.structured_threshold).toBe(500);
    expect(policy.prior_turns).toEqual({
      strategy: 'placeholder',
      assistant_preview_chars: 40,
    });
    expect(policy.tool_results.essential_fields).toEqual({
      search_hotels: ['name', 'price', 'description'],
    });

    const rawResult = JSON.stringify({
      hotels: Array.from({ length: 8 }, (_, index) => ({
        name: `Hotel ${index}`,
        price: 100 + index,
        description: 'A centrally located hotel with breakfast and late checkout.',
        internalScore: index / 10,
        rawSupplierPayload: 'x'.repeat(300),
      })),
    });
    expect(rawResult.length).toBeGreaterThan(policy.tool_results.structured_threshold);

    const compressed = compressToolResult(rawResult, 'search_hotels', policy);
    const result = JSON.parse(compressed);

    expect(compressed.length).toBeLessThan(rawResult.length);
    expect(result.hotels[0]).toEqual({
      name: 'Hotel 0',
      price: 100,
      description: 'A centrally ...',
    });
    expect(result.hotels[0].internalScore).toBeUndefined();
    expect(result.hotels[0].rawSupplierPayload).toBeUndefined();
  });
});
