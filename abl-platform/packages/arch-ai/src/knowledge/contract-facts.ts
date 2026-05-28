import {
  DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
  DEFAULT_HANDOFF_HISTORY_STRATEGY,
  getAblContractRegistry,
  type ABLConstructDoc,
} from '@abl/compiler/platform/contracts';

const registry = getAblContractRegistry();

function getConstruct(id: string): ABLConstructDoc {
  const construct = registry.constructs.find((entry) => entry.id === id);
  if (!construct) {
    throw new Error(`Missing ABL contract construct: ${id}`);
  }
  return construct;
}

const HISTORY_CONSTRUCT = getConstruct('handoff.context.history');
const ON_RETURN_CONSTRUCT = getConstruct('handoff.on_return');
const RETURN_HANDLERS_CONSTRUCT = getConstruct('handoff.return_handlers');
const MEMORY_GRANTS_CONSTRUCT = getConstruct('handoff.context.memory_grants');
const EXECUTION_TREE_CONSTRUCT = getConstruct('memory.persistent.execution_tree');
const RECALL_EVENTS_CONSTRUCT = getConstruct('memory.recall.events');

export const ARCH_COORDINATION_CONTRACT_FACTS = `### Canonical ABL Coordination Contract

- \`${HISTORY_CONSTRUCT.syntax}\` — When no explicit history strategy is declared, handoffs default to \`${DEFAULT_HANDOFF_HISTORY_STRATEGY}\`. Use \`${DEFAULT_HANDOFF_HISTORY_STRATEGY}\` by default; when summary-only would be lossy, the runtime falls back to bounded raw history (default last ${DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N} messages).
- \`${MEMORY_GRANTS_CONSTRUCT.syntax}\` — ${MEMORY_GRANTS_CONSTRUCT.summary}
- \`${ON_RETURN_CONSTRUCT.syntax}\` — ${ON_RETURN_CONSTRUCT.summary}
- \`${RETURN_HANDLERS_CONSTRUCT.syntax}\` — ${RETURN_HANDLERS_CONSTRUCT.summary}`;

export const ARCH_MEMORY_CONTRACT_FACTS = `### Canonical ABL Memory Contract

- \`${EXECUTION_TREE_CONSTRUCT.syntax}\` — ${EXECUTION_TREE_CONSTRUCT.summary}
- \`${RECALL_EVENTS_CONSTRUCT.syntax}\` — ${RECALL_EVENTS_CONSTRUCT.summary}`;
