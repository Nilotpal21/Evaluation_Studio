import { describe, expect, it } from 'vitest';

import { extractToolNames } from '@/lib/arch-ai/topology-helpers';

describe('arch-ai topology helpers', () => {
  it('extracts canonical TOOLS signatures used by runtime-ready agent edits', () => {
    const dsl = `AGENT: SupportAgent
GOAL: "Help customers"

TOOLS:
  lookup_customer(customer_id: string) -> object
    description: "Look up customer details"
  create_ticket(subject: string, priority?: string) -> object
    description: "Create a support ticket"

HANDOFF:
  - TO: BillingAgent
    WHEN: intent == "billing"
`;

    expect(extractToolNames(dsl)).toEqual(['lookup_customer', 'create_ticket']);
  });

  it('still handles legacy dash-prefixed TOOLS signatures', () => {
    const dsl = `AGENT: SupportAgent
TOOLS:
  - lookup_customer(customer_id: string) -> object
  - create_ticket(subject: string) -> object # inline comment
`;

    expect(extractToolNames(dsl)).toEqual(['lookup_customer', 'create_ticket']);
  });
});
