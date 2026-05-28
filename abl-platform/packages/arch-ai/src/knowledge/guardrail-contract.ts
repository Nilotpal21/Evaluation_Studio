import {
  getAblContractRegistry,
  type ABLDefaultGuardrailDoc,
  type ABLGuardrailAuthoringContractDoc,
} from '@abl/compiler/platform/contracts';

const registry = getAblContractRegistry();
const contract = registry.guardrails;

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderRuleLine(guardrail: ABLDefaultGuardrailDoc): string {
  return `    ${guardrail.field}: ${quoteYaml(guardrail.rule)}`;
}

function renderGuardrailLines(guardrail: ABLDefaultGuardrailDoc): string[] {
  const lines = ['GUARDRAILS:', `  ${guardrail.name}:`, `    kind: ${guardrail.kind}`];
  lines.push(renderRuleLine(guardrail));
  lines.push(`    action: ${guardrail.action}`);
  if (guardrail.threshold !== undefined) {
    lines.push(`    threshold: ${guardrail.threshold}`);
  }
  if (guardrail.message) {
    lines.push(`    message: ${quoteYaml(guardrail.message)}`);
  }
  return lines;
}

export function getGuardrailAuthoringContract(): ABLGuardrailAuthoringContractDoc {
  return contract;
}

export function renderDefaultContentSafetyGuardrail(): string {
  return renderGuardrailLines(contract.defaultContentSafety).join('\n');
}

export function renderDefaultContentSafetyInline(): string {
  const guardrail = contract.defaultContentSafety;
  const fields = [
    `kind: ${guardrail.kind}`,
    `${guardrail.field}: ${quoteYaml(guardrail.rule)}`,
    `action: ${guardrail.action}`,
  ];
  if (guardrail.threshold !== undefined) {
    fields.push(`threshold: ${guardrail.threshold}`);
  }
  if (guardrail.message) {
    fields.push(`message: ${quoteYaml(guardrail.message)}`);
  }
  return `GUARDRAILS: { ${guardrail.name}: { ${fields.join(', ')} } }`;
}

export function renderGuardrailAuthoringGuidance(): string {
  const executableFields = contract.executableFields.map((field) => `\`${field}\``).join(', ');
  const tierGuidance = contract.tierInference
    .map((entry) => `\`${entry.field}\` -> ${entry.tier}: ${entry.semantics}`)
    .join(' ');
  return [
    `Use exactly one guardrail executable field: ${executableFields}.`,
    contract.localCheckSemantics,
    tierGuidance,
    'Do not emit a `tier` field; the compiler infers it from the executable field.',
  ].join(' ');
}

export function renderDefaultContentSafetySummary(): string {
  const guardrail = contract.defaultContentSafety;
  const parts = [`kind: ${guardrail.kind}`, guardrail.field, `action: ${guardrail.action}`];
  if (guardrail.threshold !== undefined) {
    parts.push(`threshold: ${guardrail.threshold}`);
  }
  return `${guardrail.name} (${parts.join(', ')})`;
}

export function renderMissingGuardrailsWarning(): string {
  const guardrail = contract.defaultContentSafety;
  return `Missing GUARDRAILS section — add at minimum ${guardrail.name} (kind: ${guardrail.kind}, ${guardrail.field})`;
}

export function renderGuardrailCompileHint(): string {
  const localExample = contract.localViolationExample;
  return [
    `- Missing GUARDRAILS? Add: ${renderDefaultContentSafetyInline()}`,
    `- Local guardrail check? Use CEL where true means violation, e.g. ${localExample.field}: ${quoteYaml(localExample.rule)}. Do not emit tier.`,
  ].join('\n');
}
