export interface CardMappingEntry {
  id: string;
  exportName: string;
  title: string;
  sources: Array<{
    file: string;
    sections?: string[];
  }>;
  preserveContent?: string[];
  maxTokens?: number;
}

export const CARD_MAPPINGS: CardMappingEntry[] = [
  // ABL Structure & Identity
  {
    id: 'abl-anatomy',
    exportName: 'ABL_ANATOMY_CARD',
    title: 'ABL Anatomy — All Sections at a Glance',
    sources: [
      { file: 'abl-reference/language-overview.mdx' },
      {
        file: 'abl-reference/agent-declaration.mdx',
        sections: ['Agent declaration', 'File structure'],
      },
    ],
  },
  {
    id: 'execution-config',
    exportName: 'EXECUTION_CONFIG_CARD',
    title: 'EXECUTION — Model, Reasoning, Timeouts, Compaction',
    sources: [{ file: 'abl-reference/agent-declaration.mdx', sections: ['Execution'] }],
  },
  {
    id: 'limitations-vs-constraints',
    exportName: 'LIMITATIONS_VS_CONSTRAINTS_CARD',
    title: 'LIMITATIONS vs CONSTRAINTS vs GUARDRAILS',
    sources: [
      { file: 'abl-reference/memory-and-constraints.mdx', sections: ['Constraints'] },
      { file: 'abl-reference/guardrails.mdx', sections: ['Overview', 'Three-tier'] },
    ],
  },

  // FLOW Domain
  {
    id: 'flow-patterns',
    exportName: 'FLOW_PATTERNS_CARD',
    title: 'FLOW — Step Shapes, Branching, Transitions',
    sources: [{ file: 'abl-reference/flow.mdx' }],
  },
  {
    id: 'flow-reasoning-zones',
    exportName: 'FLOW_REASONING_ZONES_CARD',
    title: 'REASONING Zones — LLM-Driven Steps Inside Scripted FLOW',
    sources: [{ file: 'abl-reference/flow.mdx', sections: ['Reasoning'] }],
  },
  {
    id: 'flow-transform',
    exportName: 'FLOW_TRANSFORM_CARD',
    title: "TRANSFORM — ABL's Array Pipeline",
    sources: [
      { file: 'abl-reference/flow.mdx', sections: ['TRANSFORM'] },
      { file: 'guides/memory-and-state.mdx', sections: ['TRANSFORM'] },
    ],
  },
  {
    id: 'flow-digressions',
    exportName: 'FLOW_DIGRESSIONS_CARD',
    title: 'Digressions & Sub-Intents — Handling Off-Script User Input',
    sources: [{ file: 'abl-reference/flow.mdx', sections: ['Digression'] }],
  },

  // GATHER Domain
  {
    id: 'gather-fields',
    exportName: 'GATHER_FIELDS_CARD',
    title: 'GATHER — Field Declaration & Extraction Pipeline',
    sources: [
      { file: 'abl-reference/gather.mdx' },
      { file: 'guides/data-collection-with-gather.mdx' },
    ],
    preserveContent: [
      '### 4-Tier Extraction Pipeline\nWhen a user message arrives during GATHER:\n1. **Trivial-input skip** — "hi", "ok", single-char messages are short-circuited (saves ~1500 tokens).\n2. **JS libs** — chrono-node, libphonenumber-js for dates, phones, currency.\n3. **NLU sidecar** — embeddings-based entity resolver (enterprise only).\n4. **LLM tool-call** — `_extract_entities` function call (~$0.003/turn).\n5. **Regex fallback** — fields with `PATTERN:` declaration.',
    ],
  },
  {
    id: 'gather-validation-pii',
    exportName: 'GATHER_VALIDATION_PII_CARD',
    title: 'GATHER — Validation Modes & PII Handling',
    sources: [{ file: 'abl-reference/gather.mdx', sections: ['Validation', 'Sensitive'] }],
  },

  // Tools Domain
  {
    id: 'tool-binding-auth',
    exportName: 'TOOL_BINDING_AUTH_CARD',
    title: 'Tool Binding & Auth — Types, Declaration, Authentication',
    sources: [{ file: 'abl-reference/tools.mdx' }, { file: 'guides/tools-and-integrations.mdx' }],
    preserveContent: [
      "### 7 Auth Error Codes\n| Code | When |\n|---|---|\n| AUTH_PROFILE_NOT_FOUND | Profile lookup miss |\n| AUTH_PROFILE_TOKEN_REQUIRED | OAuth grant missing — user hasn't connected |\n| AUTH_PROFILE_CONFIG_VAR_NOT_FOUND | Template config var unresolvable |\n| AUTH_PROFILE_USER_CONTEXT_REQUIRED | User-scoped OAuth but no userId on session |\n| AUTH_PROFILE_TOKEN_URL_MISSING | Client credentials without tokenUrl |\n| AUTH_PROFILE_TOKEN_URL_BLOCKED | Token URL fails SSRF validator |\n| AUTH_PROFILE_CLIENT_CREDENTIALS_INVALID | Missing clientId/clientSecret |",
    ],
  },
  {
    id: 'tool-resolution',
    exportName: 'TOOL_RESOLUTION_CARD',
    title: 'Tool Resolution — How Names Become Implementations',
    sources: [{ file: 'abl-reference/tools.mdx', sections: ['Resolution', 'MCP'] }],
  },
  {
    id: 'tool-templates',
    exportName: 'TOOL_TEMPLATES_CARD',
    title: 'Tool Templates — Placeholder Namespaces & Secrets Resolution',
    sources: [{ file: 'abl-reference/rich-content-and-expressions.mdx', sections: ['Template'] }],
  },

  // Multi-Agent Domain
  {
    id: 'handoff-delegate',
    exportName: 'HANDOFF_DELEGATE_CARD',
    title: 'HANDOFF vs DELEGATE — Agent-to-Agent Control Transfer',
    sources: [
      { file: 'abl-reference/multi-agent-and-supervisor.mdx', sections: ['HANDOFF', 'DELEGATE'] },
      { file: 'guides/agent-collaboration-and-handoff.mdx' },
    ],
    preserveContent: [
      '### Canonical ABL Coordination Contract\n\n- `history: auto | none | summary_only | full | { mode: last_n, count }` — When no explicit history strategy is declared, handoffs default to `auto`. Use `auto` by default; when summary-only would be lossy, the runtime falls back to bounded raw history (default last 10 messages).\n- `memory_grants: [{ path, access }]`\n- `RETURN_HANDLERS: <name>: { RESPOND?, CLEAR?, CONTINUE?, RESUME_INTENT? }`',
    ],
  },
  {
    id: 'routing-intents',
    exportName: 'ROUTING_INTENTS_CARD',
    title: 'Routing & Intent Classification — Supervisor Patterns',
    sources: [
      {
        file: 'abl-reference/multi-agent-and-supervisor.mdx',
        sections: ['Routing', 'SUPERVISOR'],
      },
      { file: 'guides/multi-agent-orchestration.mdx' },
    ],
  },
  {
    id: 'cross-agent-contracts',
    exportName: 'CROSS_AGENT_CONTRACTS_CARD',
    title: 'Cross-Agent Contracts — Type Safety Across Agent Boundaries',
    sources: [
      {
        file: 'abl-reference/multi-agent-and-supervisor.mdx',
        sections: ['Contract', 'Validation'],
      },
    ],
    preserveContent: [
      '### Canonical ABL Coordination Contract\n\n- `memory_grants: [{ path, access }]`\n- `RETURN_HANDLERS: <name>: { RESPOND?, CLEAR?, CONTINUE?, RESUME_INTENT? }`',
    ],
  },

  // Safety & Quality
  {
    id: 'guardrails-tiers',
    exportName: 'GUARDRAILS_TIERS_CARD',
    title: 'GUARDRAILS — Three-Tier Safety System',
    sources: [
      { file: 'abl-reference/guardrails.mdx' },
      { file: 'guides/safety-and-guardrails.mdx' },
    ],
  },
  {
    id: 'error-handling',
    exportName: 'ERROR_HANDLING_CARD',
    title: 'Error Handling — Resolution Chain & Recovery',
    sources: [{ file: 'abl-reference/lifecycle-and-hooks.mdx', sections: ['ON_ERROR'] }],
  },
  {
    id: 'escalate-a2a',
    exportName: 'ESCALATE_A2A_CARD',
    title: 'ESCALATE & A2A — Human Handoff & Cross-Service Communication',
    sources: [{ file: 'abl-reference/multi-agent-and-supervisor.mdx', sections: ['ESCALATE'] }],
  },
  {
    id: 'external-agents',
    exportName: 'EXTERNAL_AGENTS_CARD',
    title: 'External Agent Registry — Remote A2A Handoffs',
    sources: [
      {
        file: 'abl-reference/multi-agent-and-supervisor.mdx',
        sections: ['Remote Agent', 'External Agent Registry + arch-ai workflow'],
      },
    ],
    maxTokens: 2000,
  },

  // CEL & Expressions
  {
    id: 'cel-functions',
    exportName: 'CEL_FUNCTIONS_CARD',
    title: 'CEL Functions — Built-In Reference',
    sources: [
      {
        file: 'abl-reference/rich-content-and-expressions.mdx',
        sections: ['Expression', 'Function'],
      },
      { file: 'abl-reference/data-types-and-utilities.mdx' },
    ],
    preserveContent: [
      '### Usage in Different Constructs\n\n```yaml\n# In CONSTRAINTS:\nREQUIRE: "kyc_status == \'verified\'"\n\n# In GATHER VALIDATION:\nVALIDATION: "size(account_number) >= 8 && size(account_number) <= 12"\n\n# In FLOW ON_INPUT:\nIF: "input contains \'yes\' || input contains \'confirm\'"\n\n# In COMPLETE:\nCOMPLETE:\n  - WHEN: has(order_id) && payment_status == \'confirmed\'\n    RESPOND: ""\n\n# In TRANSFORM MAP:\ndisplay_amount: FORMAT_CURRENCY(ABS(txn.amount), "USD")\n```',
    ],
  },
  {
    id: 'cel-pitfalls',
    exportName: 'CEL_PITFALLS_CARD',
    title: 'CEL Pitfalls — What Silently Bites',
    sources: [{ file: 'abl-reference/data-types-and-utilities.mdx', sections: ['Pitfall'] }],
  },

  // Memory & State
  {
    id: 'memory-full',
    exportName: 'MEMORY_FULL_CARD',
    title: 'MEMORY — Four Sub-Blocks for Agent State',
    sources: [
      { file: 'abl-reference/memory-and-constraints.mdx', sections: ['Memory'] },
      { file: 'guides/memory-and-state.mdx' },
    ],
    preserveContent: [
      '### Canonical ABL Memory Contract\n\n- `MEMORY: persistent: - PATH: <name> / SCOPE: execution_tree`\n- `ON: session:start | agent:*:after | ...`',
    ],
  },

  // Supporting Constructs
  {
    id: 'nlu-entities',
    exportName: 'NLU_ENTITIES_CARD',
    title: 'NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES',
    sources: [{ file: 'abl-reference/nlu.mdx' }],
  },
  {
    id: 'behavior-profiles',
    exportName: 'BEHAVIOR_PROFILES_CARD',
    title: 'BEHAVIOR_PROFILE — Deployment-Time Overrides',
    sources: [{ file: 'abl-reference/agent-declaration.mdx', sections: ['BEHAVIOR_PROFILE'] }],
  },
  {
    id: 'hooks-lifecycle',
    exportName: 'HOOKS_LIFECYCLE_CARD',
    title: 'HOOKS, ACTION_HANDLERS, RETURN_HANDLERS, MESSAGES, COMPLETE',
    sources: [{ file: 'abl-reference/lifecycle-and-hooks.mdx' }],
  },
  {
    id: 'rich-content',
    exportName: 'RICH_CONTENT_CARD',
    title: 'Rich Content — Widgets, Charts, Quick Replies',
    sources: [
      { file: 'abl-reference/rich-content-and-expressions.mdx', sections: ['Rich Content'] },
    ],
  },
  {
    id: 'attachments-kb',
    exportName: 'ATTACHMENTS_KB_CARD',
    title: 'Attachments & Knowledge Bases',
    sources: [
      { file: 'abl-reference/agent-declaration.mdx', sections: ['Attachment'] },
      { file: 'guides/knowledge-bases.mdx' },
    ],
  },

  // Project-Level
  {
    id: 'project-config',
    exportName: 'PROJECT_CONFIG_CARD',
    title: 'Project Configuration — Platform-Level Settings',
    sources: [
      { file: 'guides/publishing-and-operations.mdx' },
      { file: 'admin/workspace-configuration.mdx' },
    ],
  },

  // Workflow Cards
  {
    id: 'diagnostics-workflow',
    exportName: 'DIAGNOSTICS_WORKFLOW_CARD',
    title: 'Diagnostics — Validation, Debugging, Health Checks',
    sources: [{ file: 'guides/testing-and-evaluation.mdx', sections: ['Diagnostic'] }],
  },
  {
    id: 'observer-analytics',
    exportName: 'OBSERVER_ANALYTICS_CARD',
    title: 'Observer & Analytics — Briefings, Metrics, Improvement',
    sources: [{ file: 'guides/testing-and-evaluation.mdx', sections: ['Analytic', 'Metric'] }],
  },
  {
    id: 'testing-workflow',
    exportName: 'TESTING_WORKFLOW_CARD',
    title: 'Testing & Evaluation — Strategy, Scenarios, Coverage',
    sources: [{ file: 'guides/testing-and-evaluation.mdx' }],
  },
];

export function getCoveredFiles(matchedCardIds: string[]): Set<string> {
  const covered = new Set<string>();
  const matchedSet = new Set(matchedCardIds);
  for (const card of CARD_MAPPINGS) {
    if (matchedSet.has(card.id)) {
      for (const source of card.sources) {
        covered.add(source.file);
      }
    }
  }
  return covered;
}
