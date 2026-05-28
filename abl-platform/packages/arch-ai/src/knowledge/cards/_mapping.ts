// Card-to-MDX file coverage mapping for L3 deduplication.
// This is a runtime-only subset of tools/abl-docs/card-mapping.ts.
// Maps card IDs to the MDX files they cover, so L3 can skip
// chunks already represented by matched L2 cards.

const CARD_FILE_COVERAGE: Record<string, string[]> = {
  'abl-anatomy': ['abl-reference/language-overview.mdx', 'abl-reference/agent-declaration.mdx'],
  'execution-config': ['abl-reference/agent-declaration.mdx'],
  'limitations-vs-constraints': [
    'abl-reference/memory-and-constraints.mdx',
    'abl-reference/guardrails.mdx',
  ],
  'flow-patterns': ['abl-reference/flow.mdx'],
  'flow-reasoning-zones': ['abl-reference/flow.mdx'],
  'flow-transform': ['abl-reference/flow.mdx', 'guides/memory-and-state.mdx'],
  'flow-digressions': ['abl-reference/flow.mdx'],
  'gather-fields': ['abl-reference/gather.mdx', 'guides/data-collection-with-gather.mdx'],
  'gather-validation-pii': ['abl-reference/gather.mdx'],
  'tool-binding-auth': ['abl-reference/tools.mdx', 'guides/tools-and-integrations.mdx'],
  'tool-resolution': ['abl-reference/tools.mdx'],
  'tool-templates': ['abl-reference/rich-content-and-expressions.mdx'],
  'handoff-delegate': [
    'abl-reference/multi-agent-and-supervisor.mdx',
    'guides/agent-collaboration-and-handoff.mdx',
  ],
  'routing-intents': [
    'abl-reference/multi-agent-and-supervisor.mdx',
    'guides/multi-agent-orchestration.mdx',
  ],
  'cross-agent-contracts': ['abl-reference/multi-agent-and-supervisor.mdx'],
  'guardrails-tiers': ['abl-reference/guardrails.mdx', 'guides/safety-and-guardrails.mdx'],
  'error-handling': ['abl-reference/lifecycle-and-hooks.mdx'],
  'escalate-a2a': ['abl-reference/multi-agent-and-supervisor.mdx'],
  'cel-functions': [
    'abl-reference/rich-content-and-expressions.mdx',
    'abl-reference/data-types-and-utilities.mdx',
  ],
  'cel-pitfalls': ['abl-reference/data-types-and-utilities.mdx'],
  'memory-full': ['abl-reference/memory-and-constraints.mdx', 'guides/memory-and-state.mdx'],
  'nlu-entities': ['abl-reference/nlu.mdx'],
  'behavior-profiles': ['abl-reference/agent-declaration.mdx'],
  'hooks-lifecycle': ['abl-reference/lifecycle-and-hooks.mdx'],
  'rich-content': ['abl-reference/rich-content-and-expressions.mdx'],
  'attachments-kb': ['abl-reference/agent-declaration.mdx', 'guides/knowledge-bases.mdx'],
  'integration-setup-workflow': [
    'guides/tools-and-integrations.mdx',
    'studio/tools-knowledge-connections.mdx',
  ],
  'oauth-flow-primer': [
    'guides/tools-and-integrations.mdx',
    'admin/security-and-authentication.mdx',
  ],
  'integration-failure-diagnosis': [
    'guides/tools-and-integrations.mdx',
    'studio/testing-deployment-operations.mdx',
  ],
  'kb-tool-sequences': ['guides/knowledge-bases.mdx'],
  'kb-operations': ['guides/knowledge-bases.mdx'],
  'project-config': ['guides/publishing-and-operations.mdx', 'admin/workspace-configuration.mdx'],
  'diagnostics-workflow': ['guides/testing-and-evaluation.mdx'],
  'observer-analytics': ['guides/testing-and-evaluation.mdx'],
  'testing-workflow': ['guides/testing-and-evaluation.mdx'],
  'external-agents': ['abl-reference/multi-agent-and-supervisor.mdx'],

  // Platform cards (auto-generated)
  'channels-overview': ['guides/channels.mdx'],
  'channels-messaging': ['guides/channels.mdx'],
  'channels-voice': ['guides/channels.mdx'],
  'channels-sdk': ['api-reference/sdks.mdx'],
  'deployments-lifecycle': [
    'guides/publishing-and-operations.mdx',
    'api-reference/management-apis.mdx',
  ],
  'auth-profiles': ['admin/security-and-authentication.mdx', 'guides/tools-and-integrations.mdx'],
  'connections-integrations': ['studio/tools-knowledge-connections.mdx'],
  'kb-administration': ['guides/knowledge-bases.mdx'],
  'workflows-authoring': [
    'studio/tools-knowledge-connections.mdx',
    'studio/testing-deployment-operations.mdx',
  ],
  'testing-evals': ['guides/testing-and-evaluation.mdx'],
  'api-management': ['api-reference/management-apis.mdx'],
  'external-agents-a2a': [
    'examples/orchestration-and-integration.mdx',
    'api-reference/channels.mdx',
  ],
};

export function getCoveredFiles(matchedCardIds: string[]): Set<string> {
  const covered = new Set<string>();
  for (const cardId of matchedCardIds) {
    const files = CARD_FILE_COVERAGE[cardId];
    if (files) {
      for (const file of files) {
        covered.add(file);
      }
    }
  }
  return covered;
}
