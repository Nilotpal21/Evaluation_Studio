import { describe, expect, it } from 'vitest';
import { DEFAULT_HANDOFF_HISTORY_STRATEGY, getAblContractRegistry } from '@abl/compiler/platform';

import { HANDOFF_DELEGATE_CARD } from '../knowledge/cards/generated/handoff-delegate.js';
import { CROSS_AGENT_CONTRACTS_CARD } from '../knowledge/cards/generated/cross-agent-contracts.js';
import { MEMORY_FULL_CARD } from '../knowledge/cards/generated/memory-full.js';
import { ROUTING_INTENTS_CARD } from '../knowledge/cards/generated/routing-intents.js';
import {
  renderDefaultContentSafetyGuardrail,
  renderGuardrailAuthoringGuidance,
} from '../knowledge/guardrail-contract.js';
import {
  renderConstructExample,
  renderDefaultMemorySessionBlock,
  renderDefaultSupervisorCatchAllHandoff,
  renderMissingMemoryWarning,
  renderSupervisorCatchAllHandoffWarning,
} from '../knowledge/construct-contract.js';
import { getConstructSpec, listValidCombinations } from '../knowledge/spine.js';

describe('Arch-AI ABL contract-backed knowledge', () => {
  const registry = getAblContractRegistry();

  it('embeds canonical coordination facts from the compiler contract', () => {
    const historyConstruct = registry.constructs.find(
      (entry) => entry.id === 'handoff.context.history',
    );
    const returnHandlersConstruct = registry.constructs.find(
      (entry) => entry.id === 'handoff.return_handlers',
    );
    const memoryGrantsConstruct = registry.constructs.find(
      (entry) => entry.id === 'handoff.context.memory_grants',
    );

    expect(historyConstruct).toBeDefined();
    expect(returnHandlersConstruct).toBeDefined();
    expect(memoryGrantsConstruct).toBeDefined();

    expect(HANDOFF_DELEGATE_CARD).toContain(historyConstruct!.syntax);
    expect(HANDOFF_DELEGATE_CARD).toContain(DEFAULT_HANDOFF_HISTORY_STRATEGY);
    expect(HANDOFF_DELEGATE_CARD).toContain(returnHandlersConstruct!.syntax);
    expect(CROSS_AGENT_CONTRACTS_CARD).toContain(memoryGrantsConstruct!.syntax);
    expect(CROSS_AGENT_CONTRACTS_CARD).toContain(returnHandlersConstruct!.syntax);
  });

  it('embeds canonical memory facts from the compiler contract', () => {
    const executionTreeConstruct = registry.constructs.find(
      (entry) => entry.id === 'memory.persistent.execution_tree',
    );
    const recallConstruct = registry.constructs.find(
      (entry) => entry.id === 'memory.recall.events',
    );

    expect(executionTreeConstruct).toBeDefined();
    expect(recallConstruct).toBeDefined();

    expect(MEMORY_FULL_CARD).toContain(executionTreeConstruct!.syntax);
    expect(MEMORY_FULL_CARD).toContain(recallConstruct!.syntax);
    expect(MEMORY_FULL_CARD).toContain('session:start');
  });

  it('does not teach deprecated in-DSL routing registry blocks', () => {
    for (const card of [HANDOFF_DELEGATE_CARD, CROSS_AGENT_CONTRACTS_CARD, ROUTING_INTENTS_CARD]) {
      expect(card).not.toMatch(/(?:^|\n)\s*ROUTING:\s*(?:\n|$)/);
      expect(card).not.toMatch(/(?:^|\n)\s*AGENTS:\s*(?:\n|$)/);
    }

    expect(ROUTING_INTENTS_CARD).toContain('HANDOFF:');
    expect(CROSS_AGENT_CONTRACTS_CARD).toContain('HANDOFF:');
  });

  it('renders default guardrails from the compiler-owned authoring contract', () => {
    const guardrail = registry.guardrails.defaultContentSafety;
    const rendered = renderDefaultContentSafetyGuardrail();

    expect(rendered).toContain(`${guardrail.name}:`);
    expect(rendered).toContain(`kind: ${guardrail.kind}`);
    expect(rendered).toContain(`${guardrail.field}: "${guardrail.rule}"`);
    expect(rendered).toContain(`action: ${guardrail.action}`);
    expect(renderGuardrailAuthoringGuidance()).toContain(registry.guardrails.localCheckSemantics);
  });

  it('renders non-guardrail construct guidance from the compiler knowledge catalog', () => {
    const memory = getConstructSpec('MEMORY');
    const handoff = getConstructSpec('HANDOFF');
    const supervisorCatchAll = listValidCombinations('SUPERVISOR').find(
      (rule) => rule.ruleId === 'SUPERVISOR_NEEDS_CATCH_ALL_HANDOFF',
    );

    expect(memory).toBeDefined();
    expect(handoff).toBeDefined();
    expect(supervisorCatchAll).toBeDefined();

    expect(renderConstructExample('MEMORY')).toBe(memory!.examples[0]);
    expect(renderDefaultMemorySessionBlock('order_id')).toContain(memory!.fields[0].name);
    expect(renderMissingMemoryWarning()).toContain(memory!.name);
    expect(renderDefaultSupervisorCatchAllHandoff('FallbackAgent')).toContain(
      `${handoff!.fields.find((field) => field.name === 'WHEN')!.name}: true`,
    );
    expect(renderSupervisorCatchAllHandoffWarning()).toContain(supervisorCatchAll!.rationale);
  });
});
