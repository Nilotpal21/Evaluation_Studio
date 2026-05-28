import { BUILTIN_FUNCTIONS } from '../constructs/evaluator.js';
import { CONSTRAINT_CHECKPOINT_KIND_KEY, CONSTRAINT_CHECKPOINT_TARGET_KEY } from '../constants.js';
import {
  BUILTIN_FIELD_REFERENCE_VARS,
  DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N,
  DEFAULT_CONTENT_SAFETY_GUARDRAIL,
  DEFAULT_LOCAL_GUARDRAIL_EXAMPLE,
  GUARDRAIL_ACTION_VALUES,
  GUARDRAIL_EXECUTABLE_FIELD_VALUES,
  GUARDRAIL_KIND_VALUES,
  GUARDRAIL_TIER_INFERENCE,
  DEFAULT_HANDOFF_HISTORY_STRATEGY,
  HANDOFF_ON_RETURN_ACTION_VALUES,
  HANDOFF_TIMEOUT_ACTION_VALUES,
  TOOL_SESSION_CONTEXT_PARAM_MAP,
} from './contract-source-data.js';

export type ABLContractStability = 'core' | 'beta' | 'experimental';
export type ABLRuntimeSupport = 'wired' | 'partial' | 'planned';

export interface ABLStabilityTierDoc {
  tier: ABLContractStability;
  summary: string;
  guidance: string;
}

export interface ABLBuiltInFunctionDoc {
  name: string;
  category: string;
  pure: boolean;
  source: 'resolveValue';
}

export interface ABLBuiltInFunctionCategoryDoc {
  name: string;
  description: string;
  functions: string[];
}

export interface ABLLifecycleEventDoc {
  canonical: string;
  description: string;
  legacyAliases: string[];
  stability: ABLContractStability;
}

export interface ABLConstructDoc {
  id: string;
  title: string;
  syntax: string;
  scope: 'runtime' | 'handoff' | 'memory' | 'tooling';
  summary: string;
  stability: ABLContractStability;
  support: ABLRuntimeSupport;
}

export interface ABLHistoryStrategyDoc {
  name: string;
  syntax: string;
  description: string;
  stability: ABLContractStability;
  support: ABLRuntimeSupport;
}

export interface ABLCoordinationActionDoc {
  surface: 'handoff.on_timeout' | 'handoff.on_return';
  syntax: string;
  semantics: string;
  stability: ABLContractStability;
  support: ABLRuntimeSupport;
}

export interface ABLSystemVariableDoc {
  name: string;
  surfaces: Array<'field_reference' | 'tool_param_injection' | 'session_value_pattern'>;
  description: string;
  stability: ABLContractStability;
  support: ABLRuntimeSupport;
}

export interface ABLCompatibilityNoteDoc {
  id: string;
  category: 'syntax' | 'runtime' | 'docs';
  summary: string;
  guidance: string;
}

export interface ABLGuardrailExecutableFieldDoc {
  field: (typeof GUARDRAIL_EXECUTABLE_FIELD_VALUES)[number];
  tier: 'local' | 'model' | 'llm';
  semantics: string;
}

export interface ABLDefaultGuardrailDoc {
  name: string;
  kind: (typeof GUARDRAIL_KIND_VALUES)[number];
  field: (typeof GUARDRAIL_EXECUTABLE_FIELD_VALUES)[number];
  rule: string;
  action: (typeof GUARDRAIL_ACTION_VALUES)[number];
  threshold?: number;
  message?: string;
}

export interface ABLGuardrailAuthoringContractDoc {
  kinds: Array<(typeof GUARDRAIL_KIND_VALUES)[number]>;
  actions: Array<(typeof GUARDRAIL_ACTION_VALUES)[number]>;
  executableFields: Array<(typeof GUARDRAIL_EXECUTABLE_FIELD_VALUES)[number]>;
  tierInference: ABLGuardrailExecutableFieldDoc[];
  localCheckSemantics: string;
  defaultContentSafety: ABLDefaultGuardrailDoc;
  localViolationExample: ABLDefaultGuardrailDoc;
}

export interface ABLContractRegistry {
  version: 1;
  stabilityTiers: ABLStabilityTierDoc[];
  constructs: ABLConstructDoc[];
  guardrails: ABLGuardrailAuthoringContractDoc;
  builtInFunctions: {
    count: number;
    categories: ABLBuiltInFunctionCategoryDoc[];
    functions: ABLBuiltInFunctionDoc[];
  };
  lifecycleEvents: ABLLifecycleEventDoc[];
  historyStrategies: ABLHistoryStrategyDoc[];
  coordinationActions: ABLCoordinationActionDoc[];
  systemVariables: ABLSystemVariableDoc[];
  compatibilityNotes: ABLCompatibilityNoteDoc[];
  legacyEventAliases: Record<string, string>;
  sourceFiles: string[];
}

const BUILTIN_FUNCTION_CATEGORY_ORDER = [
  'math',
  'string',
  'formatting',
  'type_coercion',
  'array',
  'object',
  'utility',
] as const;

const BUILTIN_FUNCTION_CATEGORY_MAP = {
  math: ['ADD', 'SUB', 'MUL', 'DIV', 'ROUND', 'ABS', 'MIN', 'MAX'],
  string: [
    'UPPER',
    'LOWER',
    'TRIM',
    'SUBSTRING',
    'REPLACE',
    'SPLIT',
    'JOIN',
    'PAD_START',
    'PAD_END',
    'REPEAT',
  ],
  formatting: ['MASK', 'FORMAT_CURRENCY', 'FORMAT_DATE', 'ORDINAL'],
  type_coercion: ['IS_ARRAY', 'IS_NUMBER', 'IS_STRING', 'TO_NUMBER', 'TO_STRING'],
  array: ['LENGTH', 'ARRAY_FIND', 'ARRAY_FIND_INDEX'],
  object: ['OBJECT_KEYS', 'OBJECT_VALUES', 'OBJECT_MERGE'],
  utility: ['COALESCE', 'NOW', 'UNIQUE_ID'],
} satisfies Record<(typeof BUILTIN_FUNCTION_CATEGORY_ORDER)[number], string[]>;

const BUILTIN_FUNCTION_CATEGORY_DESCRIPTIONS: Record<string, string> = {
  math: 'Numeric helpers for arithmetic and rounding.',
  string: 'String normalization and manipulation helpers.',
  formatting: 'Presentation helpers for masking, date, and currency formatting.',
  type_coercion: 'Type predicates and basic coercion helpers.',
  array: 'Helpers for array length and simple record lookup.',
  object: 'Helpers for enumerating and merging object values.',
  utility: 'Fallback and runtime utility helpers.',
};

const STABILITY_TIERS: ABLStabilityTierDoc[] = [
  {
    tier: 'core',
    summary: 'Public contract intended for production use.',
    guidance:
      'Core constructs must stay aligned across parser, compiler, runtime, docs, and examples.',
  },
  {
    tier: 'beta',
    summary: 'Public but still evolving; consumers should expect guided change.',
    guidance:
      'Beta constructs should be documented and validated, but may require migration notes or compatibility lanes.',
  },
  {
    tier: 'experimental',
    summary: 'Not a stable public contract yet.',
    guidance:
      'Experimental constructs should warn clearly in tooling and must not be treated as guaranteed portable syntax.',
  },
];

const PUBLIC_CONTRACT_CONSTRUCTS: ABLConstructDoc[] = [
  {
    id: 'builtins.resolve_value',
    title: 'Built-in Functions',
    syntax: 'ADD(...), LOWER(...), COALESCE(...)',
    scope: 'runtime',
    summary: 'Pure and impure helper functions available to value resolution and interpolation.',
    stability: 'core',
    support: 'wired',
  },
  {
    id: 'handoff.context.history',
    title: 'Handoff History Strategy',
    syntax: 'history: auto | none | summary_only | full | { mode: last_n, count }',
    scope: 'handoff',
    summary:
      'Controls how much parent conversation history is forwarded during handoff; the platform default is auto, which prefers summary_only when a real handoff summary exists and otherwise falls back to bounded raw history.',
    stability: 'core',
    support: 'wired',
  },
  {
    id: 'handoff.on_return',
    title: 'Handoff ON_RETURN',
    syntax: 'ON_RETURN: { action|handler, map }',
    scope: 'handoff',
    summary:
      'Configures how a parent resumes after a child handoff through a structured action/handler object with optional field mapping.',
    stability: 'beta',
    support: 'partial',
  },
  {
    id: 'handoff.return_handlers',
    title: 'RETURN_HANDLERS',
    syntax: 'RETURN_HANDLERS: <name>: { RESPOND?, CLEAR?, CONTINUE?, RESUME_INTENT? }',
    scope: 'handoff',
    summary:
      'Named parent-resume handlers let RETURN:true handoffs clear state and optionally emit a follow-up response without inventing pseudo-agent targets.',
    stability: 'beta',
    support: 'wired',
  },
  {
    id: 'memory.recall.events',
    title: 'Recall Events',
    syntax: 'ON: session:start | agent:*:after | ...',
    scope: 'memory',
    summary: 'Canonical lifecycle event names used by recall hooks.',
    stability: 'beta',
    support: 'wired',
  },
  {
    id: 'handoff.context.memory_grants',
    title: 'Handoff Memory Grants',
    syntax: 'memory_grants: [{ path, access }]',
    scope: 'handoff',
    summary:
      'Explicit cross-agent grants expose only the named memory paths to the receiving agent with declared access semantics.',
    stability: 'beta',
    support: 'wired',
  },
  {
    id: 'memory.persistent.execution_tree',
    title: 'execution_tree Memory Scope',
    syntax: 'MEMORY: persistent: - PATH: <name> / SCOPE: execution_tree',
    scope: 'memory',
    summary:
      'Durable workflow-scoped memory shared across one execution or handoff tree, isolated from broader user/project persistence.',
    stability: 'beta',
    support: 'wired',
  },
  {
    id: 'lookup_tables.agent_local',
    title: 'Agent-local LOOKUP_TABLES',
    syntax: 'LOOKUP_TABLES: ...',
    scope: 'runtime',
    summary:
      'Agent-local lookup tables remain experimental; project runtime config lookup_tables are the canonical shared source for lookup-backed gathers.',
    stability: 'experimental',
    support: 'wired',
  },
  {
    id: 'tooling.generated.doc.mirrors',
    title: 'Generated Doc Mirrors',
    syntax: 'pnpm abl:docs:generate',
    scope: 'tooling',
    summary:
      'Canonical app doc mirrors are generated from shared source documents and contract facts.',
    stability: 'core',
    support: 'wired',
  },
];

const LIFECYCLE_EVENTS: ABLLifecycleEventDoc[] = [
  {
    canonical: 'session:start',
    description: 'New session begins.',
    legacyAliases: [],
    stability: 'core',
  },
  {
    canonical: 'session:end',
    description: 'Session ends.',
    legacyAliases: [],
    stability: 'core',
  },
  {
    canonical: 'agent:<name>:before',
    description: 'Before a named agent executes.',
    legacyAliases: [],
    stability: 'beta',
  },
  {
    canonical: 'agent:<name>:after',
    description: 'After a named agent completes.',
    legacyAliases: [],
    stability: 'beta',
  },
  {
    canonical: 'agent:*:before',
    description: 'Before any agent executes.',
    legacyAliases: [],
    stability: 'beta',
  },
  {
    canonical: 'agent:*:after',
    description: 'After any agent completes.',
    legacyAliases: [],
    stability: 'beta',
  },
  {
    canonical: 'tool:<name>:after',
    description: 'After a named tool executes.',
    legacyAliases: [],
    stability: 'beta',
  },
  {
    canonical: 'tool:*:after',
    description: 'After any tool executes.',
    legacyAliases: [],
    stability: 'beta',
  },
  {
    canonical: 'entity:<field>:extracted',
    description: 'After an entity or field value is extracted.',
    legacyAliases: [],
    stability: 'beta',
  },
  {
    canonical: 'step:enter:<name>',
    description: 'When a flow step is entered.',
    legacyAliases: [],
    stability: 'beta',
  },
  {
    canonical: 'step:exit:<name>',
    description: 'When a flow step is exited.',
    legacyAliases: [],
    stability: 'beta',
  },
];

const HISTORY_STRATEGIES: ABLHistoryStrategyDoc[] = [
  {
    name: 'auto',
    syntax: 'auto',
    description: `Prefer the authored handoff summary when it is present and safe to use; otherwise fall back to the last ${DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N} messages (or the project override). This is the platform default.`,
    stability: 'core',
    support: 'wired',
  },
  {
    name: 'none',
    syntax: 'none',
    description:
      'Do not pass summary or raw message history. Use this only for an intentionally fresh child context.',
    stability: 'core',
    support: 'wired',
  },
  {
    name: 'summary_only',
    syntax: 'summary_only',
    description: 'Pass only the summary field and no raw message history.',
    stability: 'core',
    support: 'wired',
  },
  {
    name: 'full',
    syntax: 'full',
    description: 'Pass summary plus the full available message history.',
    stability: 'beta',
    support: 'wired',
  },
  {
    name: 'last_n',
    syntax: '{ mode: last_n, count: <number> }',
    description:
      'Pass summary plus only the last N messages. The legacy shorthand `last_<n>` remains accepted during the compatibility window.',
    stability: 'beta',
    support: 'wired',
  },
];

const COORDINATION_ACTIONS: ABLCoordinationActionDoc[] = [
  ...HANDOFF_TIMEOUT_ACTION_VALUES.map(
    (syntax): ABLCoordinationActionDoc => ({
      surface: 'handoff.on_timeout',
      syntax,
      semantics:
        syntax === 'continue'
          ? 'Continue in the parent after timeout without escalating.'
          : 'Escalate to the configured human/system target after timeout.',
      stability: 'core',
      support: 'wired',
    }),
  ),
  {
    surface: 'handoff.on_timeout',
    syntax: 'respond:<message>',
    semantics: 'Return a custom response message when the handoff times out.',
    stability: 'beta',
    support: 'wired',
  },
  ...HANDOFF_ON_RETURN_ACTION_VALUES.map(
    (syntax): ABLCoordinationActionDoc => ({
      surface: 'handoff.on_return',
      syntax,
      semantics:
        syntax === 'continue'
          ? 'Continue the parent agent after the child returns.'
          : 'Resume the parent intent path after the child returns.',
      stability: 'beta',
      support: 'wired',
    }),
  ),
];

const FIELD_REFERENCE_VARIABLE_METADATA: Record<
  string,
  Omit<ABLSystemVariableDoc, 'name' | 'surfaces'>
> = {
  abl: {
    description: 'ABL helper-function namespace available in expression and guardrail conditions.',
    stability: 'core',
    support: 'wired',
  },
  always: {
    description: 'Built-in truthy sentinel for unconditional expressions.',
    stability: 'core',
    support: 'wired',
  },
  channel: {
    description: 'Current channel identifier available to expression validation/runtime context.',
    stability: 'core',
    support: 'wired',
  },
  customer_id: {
    description: 'Current customer/contact identifier when the runtime has resolved one.',
    stability: 'beta',
    support: 'wired',
  },
  input: {
    description: 'Current user input value.',
    stability: 'core',
    support: 'wired',
  },
  intent: {
    description: 'Current detected intent value when available.',
    stability: 'core',
    support: 'wired',
  },
  language: {
    description: 'Current language code.',
    stability: 'core',
    support: 'wired',
  },
  last_input: {
    description: 'Previous user input value when available.',
    stability: 'core',
    support: 'wired',
  },
  locale: {
    description: 'Current locale value.',
    stability: 'core',
    support: 'wired',
  },
  previous_system_message_was_offer: {
    description: 'Internal offer-tracking flag exposed to expression validation.',
    stability: 'experimental',
    support: 'wired',
  },
  result: {
    description: 'Current result variable reference when populated by execution flow.',
    stability: 'beta',
    support: 'wired',
  },
  session_id: {
    description:
      'Current session identifier; also auto-injected into tool params when declared in the tool schema.',
    stability: 'core',
    support: 'wired',
  },
  project_id: {
    description: 'Current project identifier when the runtime has resolved scoped project context.',
    stability: 'beta',
    support: 'wired',
  },
  tenant_id: {
    description:
      'Current tenant identifier; also auto-injected into tool params when declared in the tool schema.',
    stability: 'beta',
    support: 'wired',
  },
  user_id: {
    description:
      'Current authenticated user identifier. This is system-owned session context and should be treated as immutable in public ABL authoring.',
    stability: 'beta',
    support: 'wired',
  },
  turn_count: {
    description: 'Current conversation turn count.',
    stability: 'core',
    support: 'wired',
  },
  [CONSTRAINT_CHECKPOINT_KIND_KEY]: {
    description: 'Internal structural checkpoint kind for constraint evaluation.',
    stability: 'experimental',
    support: 'wired',
  },
  [CONSTRAINT_CHECKPOINT_TARGET_KEY]: {
    description: 'Internal structural checkpoint target for constraint evaluation.',
    stability: 'experimental',
    support: 'wired',
  },
};

const COMPATIBILITY_NOTES: ABLCompatibilityNoteDoc[] = [
  {
    id: 'handoff.history-default',
    category: 'runtime',
    summary: `When no explicit history strategy is declared, handoffs default to \`${DEFAULT_HANDOFF_HISTORY_STRATEGY}\`.`,
    guidance:
      'Use `summary_only` only when the handoff provides a real summary and the child should not receive raw history. `auto` keeps that behavior when safe and otherwise falls back to bounded raw history.',
  },
  {
    id: 'handoff.machine-targets',
    category: 'runtime',
    summary:
      'HANDOFF targets machine agents only: a compiled local agent or a declared remote agent endpoint.',
    guidance:
      'Use `ESCALATE` for human/system resolution. If you need a machine orchestration step before human transfer, hand off to a real agent such as `Live_Agent_Transfer`, then let that agent escalate.',
  },
  {
    id: 'handoff.history-last-n-shorthand',
    category: 'syntax',
    summary:
      'Legacy DSL `history: last_<n>` remains accepted and lowers into the canonical structured form `{ mode: last_n, count: n }`.',
    guidance:
      'Prefer the typed authoring form `history: { mode: last_n, count: n }` in new docs and generated YAML. Keep `last_<n>` only as a compatibility input.',
  },
  {
    id: 'docs.generated-mirrors',
    category: 'docs',
    summary: 'App-facing full-specification pages are generated from canonical docs sources.',
    guidance:
      'Edit `docs/reference/ABL_SPEC.md` and rerun `pnpm abl:docs:generate` instead of editing app mirror files directly.',
  },
];

const NON_PURE_FUNCTIONS = new Set(['NOW', 'UNIQUE_ID']);

function buildBuiltInFunctionDocs(): {
  count: number;
  categories: ABLBuiltInFunctionCategoryDoc[];
  functions: ABLBuiltInFunctionDoc[];
} {
  const registryNames = new Set(Object.keys(BUILTIN_FUNCTIONS));
  const categorizedNames = new Set<string>();
  const categories: ABLBuiltInFunctionCategoryDoc[] = [];
  const functions: ABLBuiltInFunctionDoc[] = [];

  for (const category of BUILTIN_FUNCTION_CATEGORY_ORDER) {
    const names = [...BUILTIN_FUNCTION_CATEGORY_MAP[category]].sort();
    for (const name of names) {
      categorizedNames.add(name);
      functions.push({
        name,
        category,
        pure: !NON_PURE_FUNCTIONS.has(name),
        source: 'resolveValue',
      });
    }

    categories.push({
      name: category,
      description: BUILTIN_FUNCTION_CATEGORY_DESCRIPTIONS[category],
      functions: names,
    });
  }

  const uncategorized = [...registryNames].filter((name) => !categorizedNames.has(name));
  const missingFromRegistry = [...categorizedNames].filter((name) => !registryNames.has(name));

  if (uncategorized.length > 0 || missingFromRegistry.length > 0) {
    throw new Error(
      `ABL built-in function category map is out of sync. Uncategorized: ${
        uncategorized.join(', ') || '(none)'
      }. Missing from runtime registry: ${missingFromRegistry.join(', ') || '(none)'}.`,
    );
  }

  return {
    count: functions.length,
    categories,
    functions,
  };
}

function buildSystemVariables(): ABLSystemVariableDoc[] {
  const toolInjectionVariables = new Set(Object.keys(TOOL_SESSION_CONTEXT_PARAM_MAP));
  const systemVariables: ABLSystemVariableDoc[] = BUILTIN_FIELD_REFERENCE_VARS.map((name) => {
    const metadata = FIELD_REFERENCE_VARIABLE_METADATA[name];

    if (!metadata) {
      throw new Error(`Missing system-variable metadata for field-reference variable "${name}".`);
    }

    const surfaces: ABLSystemVariableDoc['surfaces'] = ['field_reference'];
    if (toolInjectionVariables.has(name)) {
      surfaces.push('tool_param_injection');
    }

    return {
      name,
      surfaces,
      ...metadata,
    };
  });

  for (const toolVariable of toolInjectionVariables) {
    if (!systemVariables.some((variable) => variable.name === toolVariable)) {
      systemVariables.push({
        name: toolVariable,
        surfaces: ['field_reference', 'tool_param_injection'],
        description:
          toolVariable === 'user_id'
            ? 'Current authenticated user identifier auto-injected into tool params when declared and present in session context.'
            : `Tool session context value for ${toolVariable}.`,
        stability: 'beta',
        support: 'wired',
      });
    }
  }

  systemVariables.push({
    name: 'last_<tool_name>_result',
    surfaces: ['session_value_pattern'],
    description:
      'Raw tool result stored in session values when tool execution leaves result storage enabled.',
    stability: 'core',
    support: 'wired',
  });

  return systemVariables.sort((left, right) => left.name.localeCompare(right.name));
}

export function getAblContractRegistry(): ABLContractRegistry {
  return {
    version: 1,
    stabilityTiers: [...STABILITY_TIERS],
    constructs: [...PUBLIC_CONTRACT_CONSTRUCTS],
    guardrails: {
      kinds: [...GUARDRAIL_KIND_VALUES],
      actions: [...GUARDRAIL_ACTION_VALUES],
      executableFields: [...GUARDRAIL_EXECUTABLE_FIELD_VALUES],
      tierInference: GUARDRAIL_TIER_INFERENCE.map((entry) => ({ ...entry })),
      localCheckSemantics:
        'Local check expressions are CEL violation predicates: true means the guardrail fires and false means the content passes.',
      defaultContentSafety: { ...DEFAULT_CONTENT_SAFETY_GUARDRAIL },
      localViolationExample: { ...DEFAULT_LOCAL_GUARDRAIL_EXAMPLE },
    },
    builtInFunctions: buildBuiltInFunctionDocs(),
    lifecycleEvents: [...LIFECYCLE_EVENTS],
    historyStrategies: [...HISTORY_STRATEGIES],
    coordinationActions: [...COORDINATION_ACTIONS],
    systemVariables: buildSystemVariables(),
    compatibilityNotes: [...COMPATIBILITY_NOTES],
    legacyEventAliases: {},
    sourceFiles: [
      'packages/compiler/src/platform/contracts/abl-contract-registry.ts',
      'packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts',
      'packages/compiler/src/platform/constructs/evaluator.ts',
      'packages/compiler/src/platform/constants.ts',
      'packages/compiler/src/platform/ir/validate-coordination-config.ts',
      'packages/compiler/src/platform/ir/validate-field-refs.ts',
    ],
  };
}
