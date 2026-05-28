import { describe, expect, it, vi } from 'vitest';
import {
  findAgentRefs,
  findCelVarRefs,
  findGatherFieldRefs,
  findMemoryRefs,
  findToolConsumers,
} from '../../references/index.js';

const AGENTS = [
  {
    name: 'Router',
    dslContent: `SUPERVISOR: Router
GOAL: "Route requests"
PERSONA: "Helpful"
MEMORY:
  session:
    customer_id:
      type: string
HANDOFF:
  - TO: BillingAgent
    WHEN: customer_id != null
    CONTEXT:
      pass: [customer_id]
`,
  },
  {
    name: 'BillingAgent',
    dslContent: `AGENT: BillingAgent
GOAL: "Handle billing"
PERSONA: "Helpful"
TOOLS:
  - lookup_invoice(invoice_id)
GATHER:
  invoice_id:
    type: string
    required: true
COMPLETE:
  - WHEN: invoice_id != null
    RESPOND: "Done"
`,
  },
];

const AST_AGENTS = [
  {
    name: 'ProfileAgent',
    dslContent: `AGENT: ProfileAgent
GOAL: "Track profile"
MEMORY:
  PERSISTENT:
    - PATH: user.customer_id
      TYPE: string
`,
  },
];

describe('reference analysis', () => {
  it('finds memory declarations and cross-section references', () => {
    const result = findMemoryRefs(AGENTS, 'customer_id');

    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceAgent: 'Router', section: 'MEMORY' }),
        expect.objectContaining({ sourceAgent: 'Router', section: 'agent_dsl' }),
      ]),
    );
  });

  it('uses the parsed AST to resolve persistent memory path declarations', () => {
    const result = findMemoryRefs(AST_AGENTS, 'customer_id', 'ProfileAgent');

    expect(result.references).toEqual([
      expect.objectContaining({
        sourceAgent: 'ProfileAgent',
        section: 'MEMORY',
        evidence: 'Declares MEMORY field customer_id',
      }),
    ]);
  });

  it('finds gather field declarations and completion references', () => {
    const result = findGatherFieldRefs(AGENTS, 'invoice_id', 'BillingAgent');

    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceAgent: 'BillingAgent', section: 'GATHER' }),
        expect.objectContaining({ sourceAgent: 'BillingAgent', section: 'COMPLETE' }),
      ]),
    );
  });

  it('finds tool consumers, agent refs, and CEL variable refs', () => {
    expect(findToolConsumers(AGENTS, 'lookup_invoice').references).toEqual([
      expect.objectContaining({ kind: 'tool', sourceAgent: 'BillingAgent' }),
    ]);
    expect(findAgentRefs(AGENTS, 'BillingAgent').references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceAgent: 'Router', section: 'HANDOFF' }),
        expect.objectContaining({ sourceAgent: 'BillingAgent', section: 'declaration' }),
      ]),
    );
    expect(
      findAgentRefs(AGENTS, 'BillingAgent').references.filter(
        (reference) => reference.sourceAgent === 'Router' && reference.section === 'HANDOFF',
      ),
    ).toHaveLength(1);
    expect(findCelVarRefs(AGENTS, 'invoice_id').references).toEqual([
      expect.objectContaining({ kind: 'cel_var', sourceAgent: 'BillingAgent' }),
    ]);
  });

  it('surfaces AST parse failures while retaining regex fallback references', async () => {
    vi.resetModules();
    vi.doMock('@abl/core', () => ({
      parseAgentBasedABL: () => {
        throw new Error('parse exploded');
      },
    }));
    const { findAgentRefs: findAgentRefsWithFailingParser } =
      await import('../../references/find-references.js');

    try {
      const result = findAgentRefsWithFailingParser(
        [
          {
            name: 'BrokenRouter',
            dslContent: `AGENT: BrokenRouter
GOAL: "Route requests"
HANDOFF:
  - TO: BillingAgent
    WHEN: customer_id != null
FLOW:
  route:
    REASONING: false
    RESPOND: "Choose route"
    ON_ACTION:
      confirm:
        UNKNOWN: true
`,
          },
        ],
        'BillingAgent',
      );

      expect(result.references).toEqual([
        expect.objectContaining({
          kind: 'agent',
          sourceAgent: 'BrokenRouter',
          section: 'HANDOFF',
        }),
      ]);
      expect(result.parseErrors).toEqual([
        expect.objectContaining({ sourceAgent: 'BrokenRouter', message: 'parse exploded' }),
      ]);
      expect(result.summary).toContain('regex fallback');
    } finally {
      vi.doUnmock('@abl/core');
      vi.resetModules();
    }
  });

  it('keeps CEL AST matching scoped to executable condition surfaces', () => {
    const result = findCelVarRefs(
      [
        {
          name: 'NarrativeAgent',
          dslContent: `AGENT: NarrativeAgent
GOAL: "Mention invoice_id in ordinary prose, not a condition"
PERSONA: "Helpful"
`,
        },
      ],
      'invoice_id',
    );

    expect(result.references).toEqual([]);
    expect(result.parseErrors).toBeUndefined();
  });

  it('recursively finds action-handler handoff targets from the parsed AST', () => {
    const result = findAgentRefs(
      [
        {
          name: 'Router',
          dslContent: `AGENT: Router
GOAL: "Route by action"
HANDOFF:
  - TO: BillingAgent
    WHEN: true
ACTION_HANDLERS:
  route_billing:
    DO:
      - RESPOND: "Routing"
      - HANDOFF: BillingAgent
`,
        },
      ],
      'BillingAgent',
    );

    expect(result.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'agent',
          sourceAgent: 'Router',
          section: 'FLOW',
          evidence: 'References agent BillingAgent',
        }),
      ]),
    );
  });

  it('ignores short or generic tokens instead of scanning noisy DSL matches', () => {
    expect(findToolConsumers(AGENTS, 'id').references).toEqual([]);
    expect(findAgentRefs(AGENTS, 'to').references).toEqual([]);
    expect(findCelVarRefs(AGENTS, 'in').references).toEqual([]);
  });

  it('does not match inside longer identifier names', () => {
    expect(findGatherFieldRefs(AGENTS, 'customer').references).toEqual([]);
    expect(findMemoryRefs(AGENTS, 'invoice').references).toEqual([]);
  });
});
