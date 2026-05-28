import type { CombinationRule, ConstructSpec, FieldSpec } from '@abl/compiler/platform';

import { getConstructSpec, listAllConstructs, listValidCombinations } from './spine.js';

const FALLBACK_CONSTRUCT_NAMES = [
  'AGENT',
  'SUPERVISOR',
  'GOAL',
  'PERSONA',
  'TOOLS',
  'GUARDRAILS',
  'HANDOFF',
  'FLOW',
  'CONSTRAINTS',
  'COMPLETE',
  'LIMITATIONS',
  'GATHER',
  'MEMORY',
  'REMEMBER',
] as const;

function normalizeConstructName(name: string): string {
  return name.trim().toUpperCase();
}

function requireConstructSpec(name: string): ConstructSpec {
  const normalized = normalizeConstructName(name);
  const spec = getConstructSpec(normalized);
  if (!spec) {
    throw new Error(`Missing compiler construct contract: ${normalized}`);
  }
  return spec;
}

function findField(spec: ConstructSpec, fieldName: string): FieldSpec {
  const normalized = fieldName.trim().toLowerCase();
  const field = spec.fields.find((entry) => entry.name.toLowerCase() === normalized);
  if (!field) {
    throw new Error(`Missing compiler field contract: ${spec.name}.${fieldName}`);
  }
  return field;
}

function findCombinationRule(ruleId: string, constructName: string): CombinationRule | null {
  return listValidCombinations(constructName).find((rule) => rule.ruleId === ruleId) ?? null;
}

function renderRequiredFieldList(spec: ConstructSpec): string {
  const requiredFields = spec.fields.filter((field) => field.required).map((field) => field.name);
  return requiredFields.length > 0 ? ` Required fields: ${requiredFields.join(', ')}.` : '';
}

function renderConstructSurface(spec: ConstructSpec): string {
  return spec.fields.length === 1 && spec.fields[0]?.name === 'value' ? 'field' : 'section';
}

export function getConstructAuthoringContract(name: string): ConstructSpec {
  return requireConstructSpec(name);
}

export function renderConstructExample(name: string, exampleIndex = 0): string {
  const spec = requireConstructSpec(name);
  const example = spec.examples[exampleIndex] ?? spec.examples[0];
  if (!example) {
    throw new Error(`Compiler construct contract has no examples for ${spec.name}`);
  }
  return example;
}

export function renderConstructFieldSummary(name: string): string {
  const spec = requireConstructSpec(name);
  const fields = spec.fields.map((field) => {
    const required = field.required ? 'required' : 'optional';
    const defaultValue = field.defaultValue ? `, default ${field.defaultValue}` : '';
    return `${field.name}: ${field.type} (${required}${defaultValue})`;
  });
  return `${spec.name} fields: ${fields.join('; ')}`;
}

export function renderKnownConstructsHint(): string {
  const names = listAllConstructs()
    .map((construct) => construct.name)
    .filter((name) => /^[A-Z_]+$/.test(name));
  const uniqueNames = names.length > 0 ? [...new Set(names)].sort() : [...FALLBACK_CONSTRUCT_NAMES];
  return `ABL uses compiler-known uppercase constructs: ${uniqueNames.join(', ')}.`;
}

export function renderMissingConstructWarning(name: string, detail?: string): string {
  const spec = requireConstructSpec(name);
  const suffix = detail ? ` — ${detail}` : renderRequiredFieldList(spec);
  return `Missing ${spec.name} ${renderConstructSurface(spec)}${suffix}`;
}

export function renderMissingAgentDeclarationWarning(): string {
  const agentExample = renderConstructExample('AGENT').split(/\r?\n/, 1)[0];
  const supervisorExample = renderConstructExample('SUPERVISOR').split(/\r?\n/, 1)[0];
  return `Missing AGENT: or SUPERVISOR: declaration. ABL requires a compiler-known declaration such as ${agentExample} or ${supervisorExample}.`;
}

export function renderMissingMemoryWarning(): string {
  const memory = requireConstructSpec('MEMORY');
  const session = findField(memory, 'session');
  return renderMissingConstructWarning(
    'MEMORY',
    `add at minimum one ${session.name} variable (${session.type})`,
  );
}

export function renderDefaultMemorySessionBlock(
  variableName = 'conversation_topic',
  type = 'string',
): string {
  findField(requireConstructSpec('MEMORY'), 'session');
  return `MEMORY:
  session:
    - name: ${variableName}
      type: ${type}`;
}

export function renderMissingToolsWarning(): string {
  const tools = requireConstructSpec('TOOLS');
  const requiredFields = tools.fields
    .filter((field) => field.required)
    .map((field) => field.name)
    .join(', ');
  return renderMissingConstructWarning('TOOLS', `add tool entries with ${requiredFields}`);
}

export function renderSupervisorMissingHandoffWarning(): string {
  const supervisor = requireConstructSpec('SUPERVISOR');
  findField(supervisor, 'HANDOFF');
  return renderMissingConstructWarning('HANDOFF', 'SUPERVISOR requires a HANDOFF route list');
}

export function renderDefaultSupervisorCatchAllHandoff(targetAgent: string): string {
  const handoff = requireConstructSpec('HANDOFF');
  const when = findField(handoff, 'WHEN');
  const returnField = findField(handoff, 'RETURN');
  return `  - TO: ${targetAgent}
    ${when.name}: ${when.defaultValue ?? 'true'}
    ${returnField.name}: true`;
}

export function renderSupervisorCatchAllHandoffWarning(): string {
  const rule = findCombinationRule('SUPERVISOR_NEEDS_CATCH_ALL_HANDOFF', 'SUPERVISOR');
  const when = findField(requireConstructSpec('HANDOFF'), 'WHEN');
  const rationale =
    rule?.rationale ?? 'A supervisor needs a catch-all route to avoid stuck routing.';
  return `SUPERVISOR missing catch-all HANDOFF — ${rationale} Add final rule with ${when.name}: ${
    when.defaultValue ?? 'true'
  }.`;
}

export function renderDelegateMissingCompleteWarning(): string {
  const rule =
    findCombinationRule('RETURN_TRUE_TARGET_NEEDS_COMPLETE', 'HANDOFF') ??
    findCombinationRule('DELEGATE_TARGET_NEEDS_COMPLETE', 'DELEGATE');
  const rationale =
    rule?.rationale ??
    'Delegate and return targets need an explicit completion condition so control can return.';
  return `Agent is a delegate target but missing COMPLETE: block. ${rationale}`;
}

export function renderDelegateMissingGatherWarning(): string {
  const gather = requireConstructSpec('GATHER');
  const requiredFields = gather.fields
    .filter((field) => field.required)
    .map((field) => field.name)
    .join(', ');
  return `Delegate target has no user-facing GATHER fields. Add domain-specific GATHER fields (${requiredFields}) only when the child must ask the user directly; otherwise wire COMPLETE to CONTEXT.pass, MEMORY, FLOW SET, or tool result state.`;
}

export function renderHandoffContextPassMissingMemoryWarning(fieldName: string): string {
  findField(requireConstructSpec('HANDOFF'), 'CONTEXT');
  findField(requireConstructSpec('MEMORY'), 'session');
  return `HANDOFF CONTEXT pass field "${fieldName}" not found in MEMORY.session. Declare it first.`;
}

export function renderPciMissingConstraintsWarning(): string {
  return renderMissingConstructWarning(
    'CONSTRAINTS',
    'PCI-compliant agents need explicit data-handling constraints',
  );
}

export function renderConstructCompileHint(): string {
  return [
    `- Format error? ${renderKnownConstructsHint()} Never mix with lowercase YAML keys.`,
    `- Memory error? Declare variables used in HANDOFF CONTEXT: pass under ${renderConstructExample(
      'MEMORY',
    )
      .split(/\r?\n/)
      .slice(0, 2)
      .join(' ')}`,
    `- Supervisor error? Add catch-all as LAST HANDOFF: { TO: AgentName, WHEN: true, RETURN: true }`,
  ].join('\n');
}
