import type {
  ProjectAgentReferenceSource,
  ProjectReference,
  ReferenceParseError,
  ReferenceQueryResult,
} from './types.js';
import { parseAgentBasedABL } from '@abl/core';

const SECTION_NAMES = [
  'AGENT',
  'SUPERVISOR',
  'GOAL',
  'PERSONA',
  'MEMORY',
  'GATHER',
  'COMPLETE',
  'FLOW',
  'HANDOFF',
  'DELEGATE',
  'ON_RETURN',
  'TOOLS',
  'GUARDRAILS',
  'CONSTRAINTS',
  'RECALL',
  'EXECUTION',
  'MODEL',
  'VOICE',
  'EVENTS',
  'CHANNELS',
] as const;

const NON_FIELD_KEYS = new Set([
  'session',
  'persistent',
  'remember',
  'type',
  'prompt',
  'required',
  'initial_value',
  'path',
  'scope',
  'description',
  'validation',
  'depends_on',
  'ask',
  'store',
  'target',
  'when',
  'respond',
]);

const CEL_STOP_WORDS = new Set([
  'true',
  'false',
  'null',
  'and',
  'or',
  'not',
  'is',
  'set',
  'in',
  'contains',
  'startsWith',
  'endsWith',
  'matches',
  'abl',
  'context',
  'user',
  'session',
]);

const MIN_REFERENCE_TOKEN_LENGTH = 3;
const REFERENCE_STOP_WORDS = new Set([
  'all',
  'and',
  'any',
  'ask',
  'for',
  'id',
  'in',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  'pass',
  'set',
  'the',
  'to',
  'true',
  'type',
  'user',
]);

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(dsl: string, sectionName: string): string {
  const pattern = new RegExp(
    `(?:^|\\n)${sectionName}\\s*:\\s*\\n([\\s\\S]*?)(?=\\n(?:${SECTION_NAMES.join('|')})\\s*:|$)`,
    'i',
  );
  return pattern.exec(dsl)?.[1] ?? '';
}

function extractDeclaredKeys(section: string): string[] {
  const names = new Set<string>();
  for (const line of section.split('\n')) {
    const match = line.match(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    const key = match?.[1];
    if (key && !NON_FIELD_KEYS.has(normalize(key))) {
      names.add(key);
    }
  }
  return [...names];
}

function lineEvidence(dsl: string, needle: string): string {
  const pattern = referencePattern(needle);
  return (
    dsl
      .split('\n')
      .find((line) => pattern.test(line))
      ?.trim() ?? needle
  );
}

function referencePattern(needle: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(needle)}(?=$|[^A-Za-z0-9_])`, 'i');
}

function containsWord(dsl: string, word: string): boolean {
  return referencePattern(word).test(dsl);
}

function sourceName(agent: ProjectAgentReferenceSource): string {
  return agent.name.trim();
}

function makeSummary(count: number, noun: string): string {
  return count === 1 ? `Found 1 ${noun}.` : `Found ${count} ${noun}s.`;
}

function makeResult(
  references: ProjectReference[],
  noun: string,
  parseErrors: ReferenceParseError[],
): ReferenceQueryResult {
  const fallbackSummary =
    parseErrors.length > 0
      ? ` Used regex fallback for ${parseErrors.length} unparsable agent DSL${
          parseErrors.length === 1 ? '' : 's'
        }.`
      : '';

  return {
    references,
    summary: `${makeSummary(references.length, noun)}${fallbackSummary}`,
    ...(parseErrors.length > 0 ? { parseErrors } : {}),
  };
}

function isSearchableReferenceToken(value: string): boolean {
  const token = normalize(value);
  return token.length >= MIN_REFERENCE_TOKEN_LENGTH && !REFERENCE_STOP_WORDS.has(token);
}

function ignoredReferenceSummary(noun: string): ReferenceQueryResult {
  return {
    references: [],
    summary: `Skipped ${noun} search because the query is too short or too generic.`,
  };
}

function referenceKey(reference: ProjectReference): string {
  return [
    reference.kind,
    normalize(reference.sourceAgent),
    reference.targetAgent ? normalize(reference.targetAgent) : '',
    reference.fieldName ? normalize(reference.fieldName) : '',
    reference.toolName ? normalize(reference.toolName) : '',
    reference.variableName ? normalize(reference.variableName) : '',
    reference.section ?? '',
  ].join('|');
}

function pushReference(
  references: ProjectReference[],
  seen: Set<string>,
  reference: ProjectReference,
): void {
  const key = referenceKey(reference);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  references.push(reference);
}

interface ParsedAgentDocument {
  document: Record<string, unknown> | null;
  parseError?: string;
}

function parseAgentDocument(dslContent: string): ParsedAgentDocument {
  try {
    const parsed = parseAgentBasedABL(dslContent);
    const document = parsed.document;
    return {
      document:
        document && typeof document === 'object'
          ? (document as unknown as Record<string, unknown>)
          : null,
    };
  } catch (err) {
    return {
      document: null,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

function recordParseError(
  parseErrors: ReferenceParseError[],
  seen: Set<string>,
  agent: ProjectAgentReferenceSource,
  parsed: ParsedAgentDocument,
): void {
  if (!parsed.parseError) {
    return;
  }
  const key = `${normalize(sourceName(agent))}|${parsed.parseError}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  parseErrors.push({
    sourceAgent: sourceName(agent),
    message: parsed.parseError,
  });
}

function finalPathSegment(path: string): string {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function inferSectionFromAstPath(path: string[]): string {
  const first = path[0]?.toUpperCase();
  if (!first) {
    return 'agent_ast';
  }
  if (first === 'FLOW') {
    return 'FLOW';
  }
  if (first === 'HANDOFF') {
    return 'HANDOFF';
  }
  if (first === 'DELEGATE') {
    return 'DELEGATE';
  }
  if (first === 'COMPLETE') {
    return 'COMPLETE';
  }
  if (first === 'CONSTRAINTS') {
    return 'CONSTRAINTS';
  }
  if (first === 'GUARDRAILS') {
    return 'GUARDRAILS';
  }
  if (first === 'RECALL') {
    return 'RECALL';
  }
  return first;
}

function collectAstStringMatches(
  value: unknown,
  needle: string,
  path: string[] = [],
): Array<{ section: string; evidence: string }> {
  const matches: Array<{ section: string; evidence: string }> = [];

  if (typeof value === 'string') {
    if (containsWord(value, needle)) {
      matches.push({
        section: inferSectionFromAstPath(path),
        evidence: value,
      });
    }
    return matches;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      matches.push(...collectAstStringMatches(entry, needle, [...path, String(index)]));
    });
    return matches;
  }

  const record = objectValue(value);
  if (!record) {
    return matches;
  }

  for (const [key, entry] of Object.entries(record)) {
    matches.push(...collectAstStringMatches(entry, needle, [...path, key]));
  }

  return matches;
}

function isRelevantCelPath(path: string[]): boolean {
  const section = inferSectionFromAstPath(path);
  return [
    'COMPLETE',
    'FLOW',
    'HANDOFF',
    'DELEGATE',
    'CONSTRAINTS',
    'GUARDRAILS',
    'RECALL',
  ].includes(section);
}

function collectAstCelVarMatches(
  value: unknown,
  variableName: string,
  path: string[] = [],
): Array<{ section: string; evidence: string }> {
  const matches: Array<{ section: string; evidence: string }> = [];

  if (typeof value === 'string') {
    if (isRelevantCelPath(path) && containsWord(value, variableName)) {
      matches.push({
        section: inferSectionFromAstPath(path),
        evidence: value,
      });
    }
    return matches;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      matches.push(...collectAstCelVarMatches(entry, variableName, [...path, String(index)]));
    });
    return matches;
  }

  const record = objectValue(value);
  if (!record) {
    return matches;
  }

  for (const [key, entry] of Object.entries(record)) {
    matches.push(...collectAstCelVarMatches(entry, variableName, [...path, key]));
  }

  return matches;
}

function collectAstGatherNames(doc: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of arrayValue(doc.gather)) {
    const name = stringValue(objectValue(field)?.name);
    if (name) {
      names.add(name);
    }
  }

  const flow = objectValue(doc.flow);
  const definitions = objectValue(flow?.definitions);
  for (const step of Object.values(definitions ?? {})) {
    const gather = objectValue(objectValue(step)?.gather);
    for (const field of arrayValue(gather?.fields)) {
      const name = stringValue(objectValue(field)?.name);
      if (name) {
        names.add(name);
      }
    }
  }

  return [...names];
}

function collectAstMemoryNames(doc: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const memory = objectValue(doc.memory);
  for (const entry of arrayValue(memory?.session)) {
    const name = stringValue(objectValue(entry)?.name);
    if (name) {
      names.add(name);
    }
  }
  for (const entry of arrayValue(memory?.persistent)) {
    const path = stringValue(objectValue(entry)?.path);
    if (path) {
      names.add(path);
      names.add(finalPathSegment(path));
    }
  }
  return [...names];
}

function collectAstToolNames(doc: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const tool of arrayValue(doc.tools)) {
    if (typeof tool === 'string') {
      names.add(tool);
      continue;
    }
    const record = objectValue(tool);
    const name = stringValue(record?.name) ?? stringValue(record?.tool) ?? stringValue(record?.id);
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

function collectAstAgentTargets(
  doc: Record<string, unknown>,
): Array<{ target: string; section: string }> {
  const targets: Array<{ target: string; section: string }> = [];
  for (const handoff of arrayValue(doc.handoff)) {
    const target = stringValue(objectValue(handoff)?.to);
    if (target) {
      targets.push({ target, section: 'HANDOFF' });
    }
  }
  for (const delegate of arrayValue(doc.delegate)) {
    const record = objectValue(delegate);
    const target = stringValue(record?.agent) ?? stringValue(record?.to);
    if (target) {
      targets.push({ target, section: 'DELEGATE' });
    }
  }

  const flow = objectValue(doc.flow);
  const definitions = objectValue(flow?.definitions);
  for (const step of Object.values(definitions ?? {})) {
    collectActionTargets(objectValue(step)?.onAction, targets, 'FLOW');
  }
  collectActionTargets(doc.actionHandlers, targets, 'FLOW');

  const escalate = objectValue(doc.escalate);
  for (const trigger of arrayValue(escalate?.triggers)) {
    const target = stringValue(objectValue(trigger)?.target);
    if (target) {
      targets.push({ target, section: 'ESCALATE' });
    }
  }

  return targets;
}

function collectActionTargets(
  handlers: unknown,
  targets: Array<{ target: string; section: string }>,
  section: string,
): void {
  collectActionTargetValues(handlers, targets, section);
}

function collectActionTargetValues(
  value: unknown,
  targets: Array<{ target: string; section: string }>,
  section: string,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectActionTargetValues(entry, targets, section);
    }
    return;
  }

  const record = objectValue(value);
  if (!record) {
    return;
  }

  const handoff = stringValue(record.handoff);
  if (handoff) {
    targets.push({ target: handoff, section });
  }
  const delegate = stringValue(record.delegate);
  if (delegate) {
    targets.push({ target: delegate, section });
  }

  for (const entry of Object.values(record)) {
    collectActionTargetValues(entry, targets, section);
  }
}

export function findMemoryRefs(
  agents: ProjectAgentReferenceSource[],
  memoryName: string,
  agentName?: string,
): ReferenceQueryResult {
  if (!isSearchableReferenceToken(memoryName)) {
    return ignoredReferenceSummary('memory reference');
  }

  const target = normalize(memoryName);
  const scopedAgent = agentName ? normalize(agentName) : null;
  const references: ProjectReference[] = [];
  const seen = new Set<string>();
  const parseErrors: ReferenceParseError[] = [];
  const seenParseErrors = new Set<string>();

  for (const agent of agents) {
    if (scopedAgent && normalize(sourceName(agent)) !== scopedAgent) {
      continue;
    }
    const parsed = parseAgentDocument(agent.dslContent);
    recordParseError(parseErrors, seenParseErrors, agent, parsed);
    const doc = parsed.document;
    if (doc) {
      if (collectAstMemoryNames(doc).some((name) => normalize(name) === target)) {
        pushReference(references, seen, {
          kind: 'memory',
          sourceAgent: sourceName(agent),
          fieldName: memoryName,
          section: 'MEMORY',
          evidence: `Declares MEMORY field ${memoryName}`,
        });
      }
      for (const match of collectAstStringMatches(
        {
          recall: objectValue(doc.memory)?.recall,
          remember: objectValue(doc.memory)?.remember,
          complete: doc.complete,
          flow: doc.flow,
          handoff: doc.handoff,
          delegate: doc.delegate,
          constraints: doc.constraints,
          guardrails: doc.guardrails,
        },
        memoryName,
      )) {
        pushReference(references, seen, {
          kind: 'memory',
          sourceAgent: sourceName(agent),
          fieldName: memoryName,
          section: match.section,
          evidence: match.evidence,
        });
      }
    }

    const nonDeclarationDsl = agent.dslContent.replace(
      extractSection(agent.dslContent, 'MEMORY'),
      '',
    );
    if (containsWord(nonDeclarationDsl, memoryName)) {
      pushReference(references, seen, {
        kind: 'memory',
        sourceAgent: sourceName(agent),
        fieldName: memoryName,
        section: 'agent_dsl',
        evidence: lineEvidence(nonDeclarationDsl, memoryName),
      });
    }
    const declared = extractDeclaredKeys(extractSection(agent.dslContent, 'MEMORY'));
    if (declared.some((name) => normalize(name) === target)) {
      pushReference(references, seen, {
        kind: 'memory',
        sourceAgent: sourceName(agent),
        fieldName: memoryName,
        section: 'MEMORY',
        evidence: `Declares MEMORY field ${memoryName}`,
      });
    }
  }

  return makeResult(references, 'memory reference', parseErrors);
}

export function findGatherFieldRefs(
  agents: ProjectAgentReferenceSource[],
  fieldName: string,
  agentName?: string,
): ReferenceQueryResult {
  if (!isSearchableReferenceToken(fieldName)) {
    return ignoredReferenceSummary('gather field reference');
  }

  const target = normalize(fieldName);
  const scopedAgent = agentName ? normalize(agentName) : null;
  const references: ProjectReference[] = [];
  const seen = new Set<string>();
  const parseErrors: ReferenceParseError[] = [];
  const seenParseErrors = new Set<string>();

  for (const agent of agents) {
    if (scopedAgent && normalize(sourceName(agent)) !== scopedAgent) {
      continue;
    }
    const parsed = parseAgentDocument(agent.dslContent);
    recordParseError(parseErrors, seenParseErrors, agent, parsed);
    const doc = parsed.document;
    if (doc) {
      if (collectAstGatherNames(doc).some((name) => normalize(name) === target)) {
        pushReference(references, seen, {
          kind: 'gather_field',
          sourceAgent: sourceName(agent),
          fieldName,
          section: 'GATHER',
          evidence: `Declares GATHER field ${fieldName}`,
        });
      }
      for (const match of collectAstStringMatches(
        {
          complete: doc.complete,
          flow: doc.flow,
          handoff: doc.handoff,
          delegate: doc.delegate,
          constraints: doc.constraints,
        },
        fieldName,
      )) {
        pushReference(references, seen, {
          kind: 'gather_field',
          sourceAgent: sourceName(agent),
          fieldName,
          section: match.section,
          evidence: match.evidence,
        });
      }
    }

    const declared = extractDeclaredKeys(extractSection(agent.dslContent, 'GATHER'));
    if (declared.some((name) => normalize(name) === target)) {
      pushReference(references, seen, {
        kind: 'gather_field',
        sourceAgent: sourceName(agent),
        fieldName,
        section: 'GATHER',
        evidence: `Declares GATHER field ${fieldName}`,
      });
    }
    for (const sectionName of ['COMPLETE', 'FLOW', 'HANDOFF', 'CONSTRAINTS'] as const) {
      const section = extractSection(agent.dslContent, sectionName);
      if (containsWord(section, fieldName)) {
        pushReference(references, seen, {
          kind: 'gather_field',
          sourceAgent: sourceName(agent),
          fieldName,
          section: sectionName,
          evidence: lineEvidence(section, fieldName),
        });
      }
    }
  }

  return makeResult(references, 'gather field reference', parseErrors);
}

export function findToolConsumers(
  agents: ProjectAgentReferenceSource[],
  toolName: string,
): ReferenceQueryResult {
  if (!isSearchableReferenceToken(toolName)) {
    return ignoredReferenceSummary('tool consumer');
  }

  const references: ProjectReference[] = [];
  const seen = new Set<string>();
  const parseErrors: ReferenceParseError[] = [];
  const seenParseErrors = new Set<string>();

  for (const agent of agents) {
    const parsed = parseAgentDocument(agent.dslContent);
    recordParseError(parseErrors, seenParseErrors, agent, parsed);
    const doc = parsed.document;
    const astHasTool = doc
      ? collectAstToolNames(doc).some((name) => normalize(name) === normalize(toolName))
      : false;
    if (astHasTool || containsWord(extractSection(agent.dslContent, 'TOOLS'), toolName)) {
      pushReference(references, seen, {
        kind: 'tool',
        sourceAgent: sourceName(agent),
        toolName,
        section: 'TOOLS',
        evidence: astHasTool
          ? `Declares or consumes tool ${toolName}`
          : lineEvidence(extractSection(agent.dslContent, 'TOOLS'), toolName),
      });
    }
  }
  return makeResult(references, 'tool consumer', parseErrors);
}

export function findAgentRefs(
  agents: ProjectAgentReferenceSource[],
  agentName: string,
): ReferenceQueryResult {
  if (!isSearchableReferenceToken(agentName)) {
    return ignoredReferenceSummary('agent reference');
  }

  const target = normalize(agentName);
  const references: ProjectReference[] = [];
  const seen = new Set<string>();
  const parseErrors: ReferenceParseError[] = [];
  const seenParseErrors = new Set<string>();

  for (const agent of agents) {
    const parsed = parseAgentDocument(agent.dslContent);
    recordParseError(parseErrors, seenParseErrors, agent, parsed);
    const doc = parsed.document;
    const declaredName = stringValue(doc?.name) ?? sourceName(agent);
    if (normalize(declaredName) === target || normalize(sourceName(agent)) === target) {
      pushReference(references, seen, {
        kind: 'agent',
        sourceAgent: sourceName(agent),
        targetAgent: agentName,
        section: 'declaration',
        evidence: `Declares agent ${agentName}`,
      });
    }

    if (doc) {
      for (const astTarget of collectAstAgentTargets(doc)) {
        if (normalize(astTarget.target) === target) {
          pushReference(references, seen, {
            kind: 'agent',
            sourceAgent: sourceName(agent),
            targetAgent: agentName,
            section: astTarget.section,
            evidence: `References agent ${agentName}`,
          });
        }
      }
    }

    for (const sectionName of ['HANDOFF', 'DELEGATE', 'FLOW', 'COMPLETE'] as const) {
      const section = extractSection(agent.dslContent, sectionName);
      if (containsWord(section, agentName)) {
        pushReference(references, seen, {
          kind: 'agent',
          sourceAgent: sourceName(agent),
          targetAgent: agentName,
          section: sectionName,
          evidence: lineEvidence(section, agentName),
        });
      }
    }
  }

  return makeResult(references, 'agent reference', parseErrors);
}

export function findCelVarRefs(
  agents: ProjectAgentReferenceSource[],
  variableName: string,
  agentName?: string,
): ReferenceQueryResult {
  if (!isSearchableReferenceToken(variableName) || CEL_STOP_WORDS.has(normalize(variableName))) {
    return ignoredReferenceSummary('CEL variable reference');
  }

  const scopedAgent = agentName ? normalize(agentName) : null;
  const references: ProjectReference[] = [];
  const seen = new Set<string>();
  const parseErrors: ReferenceParseError[] = [];
  const seenParseErrors = new Set<string>();

  for (const agent of agents) {
    if (scopedAgent && normalize(sourceName(agent)) !== scopedAgent) {
      continue;
    }
    const parsed = parseAgentDocument(agent.dslContent);
    recordParseError(parseErrors, seenParseErrors, agent, parsed);
    const doc = parsed.document;
    if (doc) {
      for (const match of collectAstCelVarMatches(doc, variableName)) {
        pushReference(references, seen, {
          kind: 'cel_var',
          sourceAgent: sourceName(agent),
          variableName,
          section: match.section,
          evidence: match.evidence,
        });
      }
    }
    for (const sectionName of ['COMPLETE', 'FLOW', 'HANDOFF', 'CONSTRAINTS'] as const) {
      const section = extractSection(agent.dslContent, sectionName);
      if (!containsWord(section, variableName)) {
        continue;
      }
      pushReference(references, seen, {
        kind: 'cel_var',
        sourceAgent: sourceName(agent),
        variableName,
        section: sectionName,
        evidence: lineEvidence(section, variableName),
      });
    }
  }

  return makeResult(references, 'CEL variable reference', parseErrors);
}
