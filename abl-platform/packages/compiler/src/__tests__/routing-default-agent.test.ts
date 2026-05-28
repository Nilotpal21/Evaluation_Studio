import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type { AgentBasedDocument } from '@abl/core';

function parseDoc(dsl: string): AgentBasedDocument {
  const result = parseAgentBasedABL(dsl);
  expect(result.errors).toHaveLength(0);
  expect(result.document).toBeDefined();
  return result.document!;
}

function compileDocs(dsls: string[]) {
  return compileABLtoIR(dsls.map(parseDoc), { skipCrossAgentValidation: true });
}

describe('routing default agent compilation', () => {
  it('does not synthesize the first handoff as an implicit default agent', () => {
    const output = compileDocs([
      `
SUPERVISOR: WealthOpsRouter
GOAL: "Route wealth operations requests"
PERSONA: "Answer greetings directly and route explicit intents only"

HANDOFF:
  - TO: TradeInstructionAgent
    WHEN: intent.category == "trade_instruction"
    RETURN: true

  - TO: PolicyFaqAgent
    WHEN: intent.category == "policy_faq"
    RETURN: true
`,
      `
AGENT: TradeInstructionAgent
GOAL: "Collect trade instructions"
`,
      `
AGENT: PolicyFaqAgent
GOAL: "Answer policy FAQs"
`,
    ]);

    expect(output.agents.WealthOpsRouter.routing?.default_agent).toBe('');
  });

  it('uses an explicit literal true handoff as the default agent', () => {
    const output = compileDocs([
      `
SUPERVISOR: BankingSupervisor
GOAL: "Route banking requests"
PERSONA: "Route explicit intents and use fallback only when declared"

HANDOFF:
  - TO: CreditCardPaymentAgent
    WHEN: intent.category == "credit_card_payment"
    RETURN: true

  - TO: GeneralBankingAgent
    WHEN: true
    RETURN: true
`,
      `
AGENT: CreditCardPaymentAgent
GOAL: "Handle credit card payments"
`,
      `
AGENT: GeneralBankingAgent
GOAL: "Handle explicitly configured fallback banking requests"
`,
    ]);

    expect(output.agents.BankingSupervisor.routing?.default_agent).toBe('GeneralBankingAgent');
  });
});
