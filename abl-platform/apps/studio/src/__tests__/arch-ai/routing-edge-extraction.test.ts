import { describe, expect, it } from 'vitest';

import { parseAgentBasedABL } from '@abl/core';

import {
  extractRoutingEdgesFromDslFallback,
  extractRoutingEdgesFromParsedDocument,
} from '@/lib/arch-ai/routing-edge-extraction';

const AGENT_WITH_ACTION_HANDLER_ROUTING = `AGENT: RouterAgent
GOAL: "Handle action-based routing"

HANDOFF:
  - TO: BillingAgent
    WHEN: true
    RETURN: false

DELEGATE:
  - AGENT: SpecialistAgent
    WHEN: true
    PURPOSE: "Delegate specialist work"

FLOW:
  entry_point: choose
  steps:
    - choose

choose:
  REASONING: false
  RESPOND: "Choose a route"
    ACTIONS:
      - BUTTON: "Delegate" -> delegate_btn
  ON_ACTION:
    delegate_btn:
      DO:
        - DELEGATE: StepDelegate
          RETURN: true

ACTION_HANDLERS:
  escalate_btn:
    DO:
      - HANDOFF: GlobalEscalation`;

describe('routing-edge-extraction', () => {
  it('extracts top-level and action-handler routing edges from parsed ABL', () => {
    const parsed = parseAgentBasedABL(AGENT_WITH_ACTION_HANDLER_ROUTING);

    expect(parsed.document).toBeTruthy();
    expect(extractRoutingEdgesFromParsedDocument(parsed.document, 'RouterAgent')).toEqual(
      expect.arrayContaining([
        { from: 'RouterAgent', to: 'BillingAgent', type: 'handoff' },
        { from: 'RouterAgent', to: 'SpecialistAgent', type: 'delegate' },
        { from: 'RouterAgent', to: 'StepDelegate', type: 'delegate' },
        { from: 'RouterAgent', to: 'GlobalEscalation', type: 'handoff' },
      ]),
    );
  });

  it('extracts lightweight fallback routing edges from raw DSL', () => {
    expect(
      extractRoutingEdgesFromDslFallback(AGENT_WITH_ACTION_HANDLER_ROUTING, 'RouterAgent'),
    ).toEqual(
      expect.arrayContaining([
        { from: 'RouterAgent', to: 'BillingAgent', type: 'handoff' },
        { from: 'RouterAgent', to: 'SpecialistAgent', type: 'delegate' },
        { from: 'RouterAgent', to: 'StepDelegate', type: 'delegate' },
        { from: 'RouterAgent', to: 'GlobalEscalation', type: 'handoff' },
      ]),
    );
  });
});
