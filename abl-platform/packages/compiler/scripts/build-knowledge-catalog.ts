/**
 * Build-time generator for the Knowledge Spine catalog.
 *
 * Reads compiler sources and seed registries, then emits a typed catalog at:
 *   packages/compiler/src/platform/contracts/knowledge/catalog.generated.ts
 *
 * Run with: pnpm --filter @abl/compiler build:knowledge
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { LIFECYCLE_PATTERNS, LEGACY_EVENT_ALIASES } from '../src/platform/constants.js';
import { BUILTIN_FIELD_REFERENCE_VARS } from '../src/platform/contracts/contract-source-data.js';
import { getAblContractRegistry } from '../src/platform/contracts/abl-contract-registry.js';
import { CROSS_CONSTRUCT_MANDATORIES } from '../src/platform/contracts/knowledge/cross-construct-mandatories.js';
import { PER_CONTEXT_CEL_ALLOWLIST } from '../src/platform/contracts/knowledge/per-context-cel-allowlist.js';
import { VALID_COMBINATIONS } from '../src/platform/contracts/knowledge/valid-combinations-matrix.js';
import type {
  CelFunctionSpec,
  ConstructSpec,
  DiagnosticCategory,
  FeasibilityCheckSpec,
  KnowledgeCatalog,
  ValidationCodeMeta,
} from '../src/platform/contracts/knowledge/types.js';
import { VALIDATION_CODES } from '../src/platform/ir/validation-types.js';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIR = dirname(CURRENT_FILE);
const CATALOG_VERSION = '1.0.0';
const OUTPUT_PATH = join(
  CURRENT_DIR,
  '..',
  'src',
  'platform',
  'contracts',
  'knowledge',
  'catalog.generated.ts',
);
const CONTRACT_REGISTRY = getAblContractRegistry();

function resolveOutputPath(): string {
  const overridePath = process.env.KNOWLEDGE_CATALOG_OUTPUT_PATH?.trim();
  return overridePath && overridePath.length > 0 ? overridePath : OUTPUT_PATH;
}

function buildGuardrailFieldSpecs(): ConstructSpec['fields'] {
  const guardrails = CONTRACT_REGISTRY.guardrails;
  return [
    {
      name: 'kind',
      type: guardrails.kinds.join(' | '),
      required: true,
    },
    ...guardrails.tierInference.map((entry) => ({
      name: entry.field,
      type: 'string',
      required: false,
      description: `${entry.semantics} Exactly one of ${guardrails.executableFields.join(
        ', ',
      )} must be present.`,
    })),
    {
      name: 'action',
      type: guardrails.actions.join(' | '),
      required: true,
    },
  ];
}

function renderGuardrailCatalogExample(): string {
  const guardrail = CONTRACT_REGISTRY.guardrails.defaultContentSafety;
  const lines = ['GUARDRAILS:', `  ${guardrail.name}:`, `    kind: ${guardrail.kind}`];
  lines.push(`    ${guardrail.field}: "${guardrail.rule.replace(/"/g, '\\"')}"`);
  lines.push(`    action: ${guardrail.action}`);
  if (guardrail.threshold !== undefined) {
    lines.push(`    threshold: ${guardrail.threshold}`);
  }
  return lines.join('\n');
}

const CORE_CONSTRUCTS: readonly ConstructSpec[] = [
  {
    name: 'AGENT',
    fields: [
      { name: 'GOAL', type: 'string', required: true },
      { name: 'PERSONA', type: 'string', required: false },
      { name: 'TOOLS', type: 'ToolDefinition[]', required: false },
      { name: 'FLOW', type: 'FlowConfig', required: false },
    ],
    examples: ['AGENT: SupportAgent\nGOAL: "Resolve support requests"'],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [340, 390] },
  },
  {
    name: 'GOAL',
    fields: [{ name: 'value', type: 'string', required: true }],
    examples: ['GOAL: "Resolve support requests"'],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [878, 980] },
  },
  {
    name: 'PERSONA',
    fields: [{ name: 'value', type: 'string', required: true }],
    examples: ['PERSONA: |\n  You are a helpful support specialist.'],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [878, 980] },
  },
  {
    name: 'SUPERVISOR',
    fields: [
      { name: 'GOAL', type: 'string', required: true },
      { name: 'HANDOFF', type: 'HandoffConfig[]', required: true },
      { name: 'FLOW', type: 'FlowConfig', required: false },
    ],
    examples: ['SUPERVISOR: Router\nGOAL: "Route requests"\nHANDOFF:\n  - TO: Billing'],
    validInContexts: ['supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [2612, 2673] },
  },
  {
    name: 'HANDOFF',
    fields: [
      { name: 'TO', type: 'string', required: true, description: 'Target local or remote agent.' },
      { name: 'WHEN', type: 'string', required: true, defaultValue: 'true' },
      { name: 'CONTEXT', type: 'object', required: false },
      { name: 'RETURN', type: 'boolean', required: false, defaultValue: 'false' },
      { name: 'ON_RETURN', type: 'string | HandoffReturnMapping', required: false },
      { name: 'TIMEOUT', type: 'string', required: false },
      { name: 'ON_TIMEOUT', type: 'string', required: false },
    ],
    examples: ['HANDOFF:\n  - TO: BillingAgent\n    WHEN: intent == "billing"\n    RETURN: true'],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [1706, 1729] },
  },
  {
    name: 'ON_RETURN',
    fields: [
      {
        name: 'action',
        type: 'continue | resume_intent',
        required: false,
        enumValues: ['continue', 'resume_intent'],
      },
      { name: 'handler', type: 'string', required: false },
      { name: 'map', type: 'Record<string, string>', required: false },
    ],
    examples: ['ON_RETURN:\n  action: continue'],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [1680, 1695] },
  },
  {
    name: 'DELEGATE',
    fields: [
      { name: 'agent', type: 'string', required: true },
      { name: 'when', type: 'string', required: true },
      { name: 'purpose', type: 'string', required: true },
      { name: 'input', type: 'Record<string, string>', required: false },
      { name: 'returns', type: 'Record<string, string>', required: false },
      { name: 'timeout', type: 'string', required: false },
      {
        name: 'on_failure',
        type: 'continue | escalate | respond',
        required: false,
        enumValues: ['continue', 'escalate', 'respond'],
      },
    ],
    examples: [
      'DELEGATE:\n  - AGENT: RefundAgent\n    WHEN: intent == "refund"\n    PURPOSE: "Handle refunds"',
    ],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [1655, 1678] },
  },
  {
    name: 'GATHER',
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'prompt', type: 'string', required: true },
      { name: 'type', type: 'string', required: true },
      { name: 'required', type: 'boolean', required: true },
      { name: 'depends_on', type: 'string[]', required: false },
      { name: 'sensitive', type: 'boolean', required: false },
    ],
    examples: ['GATHER:\n  - name: email\n    type: email\n    prompt: "What is your email?"'],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [1356, 1471] },
  },
  {
    name: 'MEMORY',
    fields: [
      { name: 'session', type: 'SessionMemory[]', required: false },
      { name: 'persistent', type: 'PersistentMemory[]', required: false },
      { name: 'remember', type: 'RememberTrigger[]', required: false },
      { name: 'recall', type: 'RecallInstruction[]', required: false },
    ],
    examples: ['MEMORY:\n  session:\n    - name: current_topic\n      type: string'],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [1471, 1523] },
  },
  {
    name: 'FLOW',
    fields: [
      { name: 'entry_point', type: 'string', required: true },
      { name: 'steps', type: 'FlowStep[]', required: true },
    ],
    examples: ['FLOW:\n  entry_point: greet\n  steps:\n    - greet'],
    validInContexts: ['agent', 'supervisor', 'behavior_profile'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [2157, 2257] },
  },
  {
    name: 'COMPLETE',
    fields: [
      { name: 'when', type: 'string', required: true },
      { name: 'respond', type: 'string', required: false },
    ],
    examples: ['COMPLETE:\n  - WHEN: issue_resolved\n    RESPOND: "Done"'],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [372, 378] },
  },
  {
    name: 'TOOLS',
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'description', type: 'string', required: true },
      { name: 'parameters', type: 'Record<string, unknown>', required: false },
    ],
    examples: ['TOOLS:\n  - search_orders'],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [951, 1042] },
  },
  {
    name: 'GUARDRAILS',
    fields: buildGuardrailFieldSpecs(),
    examples: [renderGuardrailCatalogExample()],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [1541, 1585] },
  },
  {
    name: 'CONSTRAINTS',
    fields: [
      { name: 'condition', type: 'string', required: true },
      { name: 'on_fail', type: 'string | object', required: false },
    ],
    examples: ['CONSTRAINTS:\n  - WHEN: user_id != ""'],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [1585, 1642] },
  },
  {
    name: 'MODEL',
    fields: [
      { name: 'provider', type: 'string', required: false },
      { name: 'model', type: 'string', required: false },
      { name: 'reasoning', type: 'object', required: false },
    ],
    examples: ['MODEL:\n  provider: openai\n  model: gpt-4.1'],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [740, 837] },
  },
  {
    name: 'EXECUTION',
    fields: [
      { name: 'model', type: 'string', required: false },
      { name: 'timeouts', type: 'object', required: false },
      { name: 'pipeline', type: 'object', required: false },
    ],
    examples: ['EXECUTION:\n  model: claude-sonnet-4-5'],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [740, 837] },
  },
  {
    name: 'CHANNELS',
    fields: [
      { name: 'voice', type: 'object', required: false },
      { name: 'chat', type: 'object', required: false },
    ],
    examples: ['CHANNELS:\n  voice:\n    enabled: true'],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [632, 740] },
  },
  {
    name: 'VOICE',
    fields: [
      { name: 'voice', type: 'string', required: false },
      { name: 'model', type: 'string', required: false },
    ],
    examples: ['VOICE:\n  voice: alloy'],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [632, 740] },
  },
  {
    name: 'EVENTS',
    fields: [
      { name: 'on_start', type: 'StartConfig', required: false },
      { name: 'hooks', type: 'HooksConfig', required: false },
    ],
    examples: ['ON_START:\n  RESPOND: "Welcome"'],
    validInContexts: ['agent', 'supervisor'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [390, 430] },
  },
  {
    name: 'RECALL',
    fields: [
      { name: 'on', type: 'lifecycle event', required: true },
      { name: 'query', type: 'string', required: false },
    ],
    examples: ['RECALL:\n  - ON: session:start'],
    validInContexts: ['agent'],
    source: { file: 'packages/compiler/src/platform/ir/schema.ts', lines: [1471, 1523] },
  },
];

function mapValidationCodeToCategory(code: string): DiagnosticCategory {
  if (code.includes('FLOW') || code.includes('STEP') || code.includes('ENTRY_POINT')) {
    return 'flow';
  }
  if (code.includes('HANDOFF')) {
    return 'handoff';
  }
  if (code.includes('DELEGATE')) {
    return 'delegation';
  }
  if (code.includes('ROUTING')) {
    return 'routing';
  }
  if (code.includes('TOOL')) {
    return 'tool';
  }
  if (code.includes('GATHER') || code.includes('DEPENDS_ON') || code.includes('COLLECT_FIELD')) {
    return 'gather';
  }
  if (code.includes('MEMORY') || code.includes('PERSISTENT') || code.includes('RECALL')) {
    return 'memory';
  }
  if (code.includes('GUARDRAIL')) {
    return 'guardrail';
  }
  if (code.includes('VARIABLE') || code.includes('CONDITION')) {
    return 'constraint';
  }
  return 'other';
}

function humanizeCodeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function buildValidationCodeMeta(): Record<string, ValidationCodeMeta> {
  const metadata: Record<string, ValidationCodeMeta> = {};
  for (const [name, code] of Object.entries(VALIDATION_CODES).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    metadata[code] = {
      severity: code.includes('WARNING') || code.includes('LEGACY') ? 'warning' : 'error',
      category: mapValidationCodeToCategory(code),
      meaning: humanizeCodeName(name),
      remediation: `See ${name} in packages/compiler/src/platform/ir/validation-types.ts.`,
    };
  }
  return metadata;
}

function buildCelFunctions(): CelFunctionSpec[] {
  const registry = getAblContractRegistry();
  return registry.builtInFunctions.functions.map((fn) => ({
    name: fn.name,
    signature: `${fn.name}(...)`,
    category: fn.category,
    description: `${fn.pure ? 'Pure' : 'Runtime'} ABL helper from ${fn.source}.`,
  }));
}

function buildRuntimeFeasibilityChecks(): FeasibilityCheckSpec[] {
  return [
    {
      name: 'empty-response',
      description:
        'Agent must have a reasoning zone, a respond-capable flow/completion path, or an intentional handoff route.',
      category: 'flow',
      reusesAnalyzer: 'EmptyResponseAnalyzer',
    },
    {
      name: 'tool-binding',
      description: 'Tool references must resolve to ProjectTool implementations.',
      category: 'tool',
      reusesAnalyzer: 'ToolBindingAnalyzer',
    },
    {
      name: 'voice-model-feasibility',
      description: 'Voice channel agents require realtime voice-capable model configuration.',
      category: 'channel',
    },
    {
      name: 'provider-allowlist',
      description: 'Model providers must be allowed by tenant policy.',
      category: 'model',
    },
    {
      name: 'memory-scope-identity',
      description: 'User-scoped persistent memory requires a runtime identity source.',
      category: 'memory',
    },
  ];
}

function buildCatalog(): KnowledgeCatalog {
  const registry = getAblContractRegistry();
  return {
    version: CATALOG_VERSION,
    generatedAt: new Date().toISOString(),
    constructs: [...CORE_CONSTRUCTS].sort((left, right) => left.name.localeCompare(right.name)),
    validationCodes: buildValidationCodeMeta(),
    cel: {
      functions: buildCelFunctions(),
      globalVariables: [...BUILTIN_FIELD_REFERENCE_VARS],
      perContextAllowlist: Object.fromEntries(
        Object.entries(PER_CONTEXT_CEL_ALLOWLIST)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([context, variables]) => [context, [...variables].sort()]),
      ) as KnowledgeCatalog['cel']['perContextAllowlist'],
    },
    lifecycleEvents: [
      ...registry.lifecycleEvents.map((event) => ({
        pattern: event.canonical,
        appliesTo: ['recall' as const],
      })),
      ...LIFECYCLE_PATTERNS.map((pattern) => ({
        pattern: pattern.toString(),
        appliesTo: ['recall' as const],
      })),
      ...Object.entries(LEGACY_EVENT_ALIASES).map(([legacyAlias, pattern]) => ({
        pattern,
        appliesTo: ['recall' as const],
        legacyAlias,
      })),
    ],
    validCombinations: [...VALID_COMBINATIONS],
    crossConstructMandatories: [...CROSS_CONSTRUCT_MANDATORIES],
    runtimeFeasibilityChecks: buildRuntimeFeasibilityChecks(),
  };
}

function emit(catalog: KnowledgeCatalog): string {
  return `// AUTO-GENERATED by packages/compiler/scripts/build-knowledge-catalog.ts
// DO NOT EDIT. Re-run \`pnpm --filter @abl/compiler build:knowledge\` to regenerate.

import type { KnowledgeCatalog } from './types.js';

export const KNOWLEDGE_CATALOG: KnowledgeCatalog = ${JSON.stringify(catalog, null, 2)} as const;
`;
}

async function main(): Promise<void> {
  const catalog = buildCatalog();
  const outputPath = resolveOutputPath();
  const formatted = await format(emit(catalog), {
    endOfLine: 'lf',
    parser: 'typescript',
    printWidth: 100,
    semi: true,
    singleQuote: true,
    tabWidth: 2,
    trailingComma: 'all',
  });
  writeFileSync(outputPath, formatted, 'utf8');
  process.stdout.write(
    `Wrote knowledge catalog (${catalog.constructs.length} constructs, ${
      Object.keys(catalog.validationCodes).length
    } validation codes) to ${outputPath}\n`,
  );
}

await main();
