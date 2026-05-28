import type { SourceArchitectureContract } from '../blueprint/source-architecture-contract.js';

interface SignatureField {
  name: string;
  type: string;
}

const ORDER_PATTERN = /\b(order|shipment|shipping|delivery|tracking)\b/;
const TRACKING_PATTERN = /\b(track|tracking|shipment|shipping|delivery)\b/;
const CUSTOMER_PATTERN = /\b(customer|account|user|contact)\b/;
const EMAIL_PATTERN = /\b(email|mail)\b/;
const CASE_PATTERN = /\b(case|ticket|incident|claim)\b/;
const SEARCH_PATTERN = /\b(search|find|query)\b/;
const TEXT_ANALYSIS_PATTERN = /\b(classify|detect|extract|summarize|analyze|parse|score)\b/;
const REPLACEMENT_PATTERN = /\b(replacement|replace|reship)\b/;
const REFUND_PATTERN = /\b(refund|reimburse)\b/;
const CREDIT_PATTERN = /\b(credit|goodwill|coupon)\b/;
const NOTIFICATION_PATTERN = /\b(send|notify|message)\b/;
const LOOKUP_PATTERN = /\b(lookup|search|status|track|retrieve|fetch|find|get|check)\b/;
const SIDE_EFFECT_PATTERN =
  /\b(create|update|submit|book|schedule|send|notify|refund|charge|pay|approve|deny|file|cancel|change|modify|apply|assign|dispatch|transfer|close|open|resolve|store|save|record|provision|deprovision|delete|remove|escalate)\b/;

export function inferFallbackToolSignature(
  toolName: string,
  sourceContract?: SourceArchitectureContract | null,
): string {
  const normalizedName = normalizeIdentifier(toolName);
  const fixtureSignature = inferSignatureFromSourceFixture(normalizedName, sourceContract);
  const inputFields = fixtureSignature?.inputFields ?? inferInputFields(toolName);
  const outputFields = fixtureSignature?.outputFields ?? inferOutputFields(toolName);
  return `${normalizedName}(${renderFields(inputFields)}) -> { ${renderFields(outputFields)} }`;
}

export function isGenericFallbackToolSignature(signature: string): boolean {
  const normalized = signature.replace(/\s+/g, ' ').trim();
  return (
    /\(\s*input\s*:\s*string\s*\)\s*->\s*\{\s*result\s*:\s*string\s*\}/.test(normalized) ||
    /\(\s*input\s*:\s*string\s*\)\s*->\s*\{\s*status\s*:\s*string\s*,\s*summary\s*:\s*string\s*\}/.test(
      normalized,
    )
  );
}

function inferInputFields(toolName: string): SignatureField[] {
  const text = normalizedText(toolName);
  const fields: SignatureField[] = [];

  const needsOrderScope =
    ORDER_PATTERN.test(text) ||
    REPLACEMENT_PATTERN.test(text) ||
    REFUND_PATTERN.test(text) ||
    CREDIT_PATTERN.test(text);

  if (needsOrderScope) {
    fields.push({ name: 'order_id', type: 'string' });
  }
  if (TRACKING_PATTERN.test(text) && !fields.some((field) => field.name === 'tracking_number')) {
    fields.push({ name: 'tracking_number', type: 'string' });
  }
  if (EMAIL_PATTERN.test(text)) {
    fields.push({ name: 'email', type: 'string' });
  } else if (CUSTOMER_PATTERN.test(text)) {
    fields.push({ name: 'customer_id', type: 'string' });
  }
  if (CASE_PATTERN.test(text)) {
    fields.push({ name: 'case_id', type: 'string' });
  }
  if (SEARCH_PATTERN.test(text)) {
    fields.push({ name: 'query', type: 'string' });
  }
  if (TEXT_ANALYSIS_PATTERN.test(text)) {
    fields.push({ name: 'text', type: 'string' });
  }
  if (REPLACEMENT_PATTERN.test(text) || REFUND_PATTERN.test(text) || CREDIT_PATTERN.test(text)) {
    fields.push({ name: 'reason', type: 'string' });
  }
  if (NOTIFICATION_PATTERN.test(text)) {
    fields.push({ name: 'recipient', type: 'string' }, { name: 'message', type: 'string' });
  }

  return dedupeFields(fields.length > 0 ? fields : [{ name: 'request', type: 'string' }]);
}

function inferSignatureFromSourceFixture(
  normalizedToolName: string,
  sourceContract: SourceArchitectureContract | null | undefined,
): { inputFields: SignatureField[]; outputFields: SignatureField[] } | null {
  const inputFieldSets: SignatureField[][] = [];
  const outputFieldSets: SignatureField[][] = [];

  for (const fixture of sourceContract?.scenarioFixtures ?? []) {
    for (const toolFixture of fixture.toolFixtures) {
      if (normalizeIdentifier(toolFixture.toolName) !== normalizedToolName) continue;

      const inputFields = inferFieldsFromRecord(toolFixture.sampleInput);
      const outputFields = inferFieldsFromRecord(parseFixtureResponse(toolFixture.response));
      if (inputFields.length > 0) {
        inputFieldSets.push(inputFields);
      }
      if (outputFields.length > 0) {
        outputFieldSets.push(outputFields);
      }
    }
  }

  if (inputFieldSets.length === 0 && outputFieldSets.length === 0) {
    return null;
  }

  const inputFields = dedupeFields(inputFieldSets.flat());
  const outputFields = dedupeFields(outputFieldSets.flat());
  return {
    inputFields: inputFields.length > 0 ? inputFields : inferInputFields(normalizedToolName),
    outputFields: outputFields.length > 0 ? outputFields : inferOutputFields(normalizedToolName),
  };
}

function parseFixtureResponse(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function inferFieldsFromRecord(record: Record<string, unknown> | undefined): SignatureField[] {
  if (!record) {
    return [];
  }

  return Object.entries(record)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => ({
      name,
      type: inferFieldType(value),
    }));
}

function inferFieldType(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === 'boolean') return 'boolean[]';
    if (typeof first === 'number') return 'number[]';
    if (typeof first === 'string') return 'string[]';
    return 'object[]';
  }
  if (value && typeof value === 'object') return 'object';
  return 'string';
}

function inferOutputFields(toolName: string): SignatureField[] {
  const text = normalizedText(toolName);

  if (REPLACEMENT_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'replacement_id', type: 'string' },
      { name: 'promised_delivery_date', type: 'string' },
    ];
  }
  if (REFUND_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'refund_id', type: 'string' },
      { name: 'refund_eta', type: 'string' },
    ];
  }
  if (CREDIT_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'credit_id', type: 'string' },
      { name: 'amount', type: 'number' },
    ];
  }
  if (CASE_PATTERN.test(text) && SIDE_EFFECT_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'case_id', type: 'string' },
      { name: 'status', type: 'string' },
    ];
  }
  if (ORDER_PATTERN.test(text) || TRACKING_PATTERN.test(text)) {
    return [
      { name: 'status', type: 'string' },
      { name: 'last_scan_at', type: 'string' },
      { name: 'promised_delivery_date', type: 'string' },
      { name: 'eligible_options', type: 'string' },
    ];
  }
  if (NOTIFICATION_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'message_id', type: 'string' },
    ];
  }
  if (LOOKUP_PATTERN.test(text) || TEXT_ANALYSIS_PATTERN.test(text)) {
    return [
      { name: 'summary', type: 'string' },
      { name: 'confidence', type: 'number' },
    ];
  }
  if (SIDE_EFFECT_PATTERN.test(text)) {
    return [
      { name: 'success', type: 'boolean' },
      { name: 'reference_id', type: 'string' },
      { name: 'summary', type: 'string' },
    ];
  }

  return [{ name: 'summary', type: 'string' }];
}

function renderFields(fields: ReadonlyArray<SignatureField>): string {
  return fields.map((field) => `${field.name}: ${field.type}`).join(', ');
}

function dedupeFields(fields: ReadonlyArray<SignatureField>): SignatureField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.name)) {
      return false;
    }
    seen.add(field.name);
    return true;
  });
}

function normalizedText(value: string): string {
  return value.replace(/[_./-]+/g, ' ').toLowerCase();
}

function normalizeIdentifier(value: string): string {
  const identifier = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return identifier || 'project_tool';
}
