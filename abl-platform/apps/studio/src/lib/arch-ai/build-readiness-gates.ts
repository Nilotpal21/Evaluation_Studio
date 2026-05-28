export interface GeneratedAgentReadinessInput {
  content: string | undefined;
}

interface HandoffEntry {
  to: string;
  when: string;
}

interface CompleteEntry {
  when: string;
  respond: string;
}

const TOP_LEVEL_SECTION_BOUNDARY = '^\\S[^:\\n]*\\s*:';

function extractTopLevelSection(content: string, sectionName: string): string {
  const match = new RegExp(
    `^\\s*${sectionName}\\s*:\\s*\\n([\\s\\S]*?)(?=${TOP_LEVEL_SECTION_BOUNDARY}|(?![\\s\\S]))`,
    'm',
  ).exec(content);
  return match?.[1] ?? '';
}

function stripTopLevelSection(content: string, sectionName: string): string {
  return content.replace(
    new RegExp(
      `^\\s*${sectionName}\\s*:\\s*\\n[\\s\\S]*?(?=${TOP_LEVEL_SECTION_BOUNDARY}|(?![\\s\\S]))`,
      'm',
    ),
    '',
  );
}

function extractHandoffEntries(content: string): HandoffEntry[] {
  const body = extractTopLevelSection(content, 'HANDOFF');
  const entries: HandoffEntry[] = [];
  const matches = body.matchAll(
    /^\s*-\s*TO\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\n([\s\S]*?)(?=^\s*-\s*TO\s*:|(?![\s\S]))/gm,
  );

  for (const match of matches) {
    const to = match[1];
    if (!to) continue;
    const when = match[2]?.match(/^\s*WHEN\s*:\s*(.+)$/m)?.[1]?.trim() ?? '';
    entries.push({ to, when });
  }

  return entries;
}

function extractCompleteEntries(content: string): CompleteEntry[] {
  const body = extractTopLevelSection(content, 'COMPLETE');
  const entries: CompleteEntry[] = [];
  const matches = body.matchAll(
    /^\s*-\s*WHEN\s*:\s*(.*?)\s*\n([\s\S]*?)(?=^\s*-\s*WHEN\s*:|(?![\s\S]))/gm,
  );

  for (const match of matches) {
    const when = match[1]?.trim() ?? '';
    const respond = match[2]?.match(/^\s*RESPOND\s*:\s*(.*)$/m)?.[1]?.trim() ?? '';
    entries.push({ when, respond });
  }

  return entries;
}

function extractRespondValues(content: string): string[] {
  return [...content.matchAll(/^\s*RESPOND\s*:\s*(.*)$/gm)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((value) => value.length > 0);
}

function isEmptyRespondValue(value: string): boolean {
  return /^(?:""|''|""\s*#.*|''\s*#.*)$/.test(value.trim());
}

function hasNonEmptyRespondBeforeCompletion(content: string): boolean {
  const withoutOnStart = stripTopLevelSection(content, 'ON_START');
  const withoutComplete = stripTopLevelSection(withoutOnStart, 'COMPLETE');
  return extractRespondValues(withoutComplete).some((value) => !isEmptyRespondValue(value));
}

function isCatchAllCondition(value: string): boolean {
  return /^(?:true|["']true["']|\*)$/i.test(value.trim());
}

function isUnconditionalCondition(value: string): boolean {
  return value.trim().length === 0 || isCatchAllCondition(value);
}

function hasStructuredFlowOutputBeforeCompletion(content: string): boolean {
  const flow = extractTopLevelSection(content, 'FLOW');
  return /^\s*(?:AS|CALL|GATHER|SET|TRANSFORM|REMEMBER)\s*:/m.test(flow);
}

function stripRoutingIntentPresenceGuards(value: string): string {
  return value
    .replace(/\(?\s*\brouting_intent\s*!=\s*(?:null|""|'')\s*\)?/gi, '')
    .replace(/\(?\s*\brouting_intent\s+IS\s+NOT\s+NULL\s*\)?/gi, '');
}

function mixesRoutingVocabulary(value: string): boolean {
  if (!/\bintent\.category\b/.test(value) || !/\brouting_intent\b/.test(value)) {
    return false;
  }
  return /\brouting_intent\b/.test(stripRoutingIntentPresenceGuards(value));
}

export function collectGeneratedAgentReadinessErrors(
  input: GeneratedAgentReadinessInput,
): string[] {
  const content = input.content ?? '';
  if (!content.trim()) {
    return [];
  }

  const errors: string[] = [];
  const handoffs = extractHandoffEntries(content);

  for (const handoff of handoffs) {
    if (mixesRoutingVocabulary(handoff.when)) {
      errors.push(
        `Runtime readiness: HANDOFF to "${handoff.to}" uses routing_intent as a classifier value while also checking intent.category. Use one routing state vocabulary or explicitly map classifier output before routing.`,
      );
    }
  }

  const completeEntries = extractCompleteEntries(content);
  if (
    completeEntries.some(
      (entry) => isUnconditionalCondition(entry.when) && isEmptyRespondValue(entry.respond),
    ) &&
    !hasNonEmptyRespondBeforeCompletion(content) &&
    !hasStructuredFlowOutputBeforeCompletion(content)
  ) {
    errors.push(
      'Runtime readiness: agent has an unconditional silent COMPLETE. Generated agents must produce a non-empty customer-facing response, answer before completing, or complete silently only through a state-driven parent return.',
    );
  }

  return errors;
}
