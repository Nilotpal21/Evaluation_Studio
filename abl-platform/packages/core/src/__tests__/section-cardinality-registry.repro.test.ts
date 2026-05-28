// REGRESSION: ABLP-1032
// ABLP-1032 regression coverage: repeatable sections must accumulate
// consistently instead of silently overwriting earlier blocks.

import { describe, expect, test } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

type RepeatableSectionCase = {
  name: string;
  dsl: string;
  readValues: (
    document: NonNullable<ReturnType<typeof parseAgentBasedABL>['document']>,
  ) => string[];
  expected: string[];
};

const repeatableSectionCases: RepeatableSectionCase[] = [
  {
    name: 'TOOLS',
    dsl: `
AGENT: ToolCardinality

GOAL: "Preserve tools across repeated sections"

TOOLS:
  search(query: string) -> object
    description: "Search"

TOOLS:
  calculate(expression: string) -> object
    description: "Calculate"
`,
    readValues: (document) => document.tools.map((tool) => tool.name),
    expected: ['search', 'calculate'],
  },
  {
    name: 'MEMORY',
    dsl: `
AGENT: MemoryCardinality

GOAL: "Preserve memory across repeated sections"

MEMORY:
  SESSION:
    - name: userId
      type: string
      description: "User id"

MEMORY:
  SESSION:
    - name: orderId
      type: string
      description: "Order id"
`,
    readValues: (document) => document.memory.session.map((entry) => entry.name),
    expected: ['userId', 'orderId'],
  },
  {
    name: 'HANDOFF',
    dsl: `
AGENT: HandoffCardinality

GOAL: "Preserve handoffs across repeated sections"

HANDOFF:
  - TO: SupportAgent
    WHEN: user needs support

HANDOFF:
  - TO: SalesAgent
    WHEN: user wants to buy
`,
    readValues: (document) => document.handoff.map((entry) => entry.to),
    expected: ['SupportAgent', 'SalesAgent'],
  },
  {
    name: 'DELEGATE',
    dsl: `
AGENT: DelegateCardinality

GOAL: "Preserve delegates across repeated sections"

DELEGATE:
  - AGENT: SummaryAgent
    WHEN: user asks for a summary
    PURPOSE: "Summarize"
    INPUT: {}
    RETURNS: {}
    USE_RESULT: "Use the summary"

DELEGATE:
  - AGENT: BillingAgent
    WHEN: user asks about billing
    PURPOSE: "Handle billing"
    INPUT: {}
    RETURNS: {}
    USE_RESULT: "Use the billing result"
`,
    readValues: (document) => document.delegate.map((entry) => entry.agent),
    expected: ['SummaryAgent', 'BillingAgent'],
  },
  {
    name: 'TEMPLATES',
    dsl: `
AGENT: TemplateCardinality

GOAL: "Preserve templates across repeated sections"

TEMPLATES:
  greeting:
    text: "Hello"

TEMPLATES:
  farewell:
    text: "Goodbye"
`,
    readValues: (document) => document.templates?.map((entry) => entry.name) ?? [],
    expected: ['greeting', 'farewell'],
  },
];

describe('ABLP-1032 DSL section cardinality registry', () => {
  test.each(repeatableSectionCases)(
    '$name is declared repeatable and preserves every block',
    ({ dsl, expected, readValues }) => {
      const result = parseAgentBasedABL(dsl);

      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(readValues(result.document!)).toEqual(expect.arrayContaining(expected));
    },
  );
});
