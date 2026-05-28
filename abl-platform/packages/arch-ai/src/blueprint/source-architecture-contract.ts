import type { SessionFileRecord } from '../session/file-store-service.js';
import type { TopologyOutput } from '../types/blueprint.js';
import { inferArchModelPolicyFromText, type ArchModelPolicy } from '../model-policy.js';

export interface SourceContractProvenance {
  fileName: string;
  section?: string;
}

export interface SourceContractAgent {
  name: string;
  role: string;
  tools: string[];
  memoryVariables: string[];
  limitations: string[];
  modelPolicy?: ArchModelPolicy;
  provenance: SourceContractProvenance;
}

export interface SourceContractTool {
  name: string;
  signature?: string;
  description?: string;
  callWhen?: string[];
  doNotCallWhen?: string[];
  source?: string;
  provenance: SourceContractProvenance;
}

export interface SourceContractWelcomeShape {
  personaName?: string;
  openingLine?: string;
  voiceMaxWords?: number;
  chatMaxWords?: number;
  continuity: 'single_perceived_agent' | 'agent_specific' | 'unspecified';
  provenance: SourceContractProvenance;
}

export interface SourceContractChannelRule {
  channel: string;
  welcomeMaxWords?: number;
  responseMaxWords?: number;
  abbreviationPolicy?: 'expand_for_voice' | 'preserve_text';
  toolLatencyBridge?: boolean;
  requiresTemplate?: boolean;
  requiresRecordingConsent?: boolean;
  rules: string[];
  provenance: SourceContractProvenance;
}

export interface SourceContractConsentPolicy {
  toolName?: string;
  action: string;
  mode: 'never' | 'always' | 'when_side_effects';
  requiredIn: 'conversation' | 'explicit_prompt';
  scopeFields: string[];
  fallback: 'explicit_prompt' | 'block';
  provenance: SourceContractProvenance;
}

export interface SourceContractScenarioFixture {
  name: string;
  channel?: string;
  userMessage: string;
  expectedOutcome?: string;
  toolFixtures: Array<{
    toolName: string;
    sampleInput?: Record<string, unknown>;
    response: string;
  }>;
  provenance: SourceContractProvenance;
}

export interface SourceContractBehaviorProfile {
  name: string;
  dslContent: string;
  provenance: SourceContractProvenance;
}

export interface SourceArchitectureContract {
  sourceFiles: string[];
  declaredAgents: SourceContractAgent[];
  entryAgent?: string;
  channels: string[];
  requiredMcpServers: string[];
  sharedMemoryVariables: string[];
  universalRules: string[];
  guardrails: string[];
  tools: SourceContractTool[];
  welcomeShape?: SourceContractWelcomeShape;
  channelRules?: SourceContractChannelRule[];
  consentPolicies?: SourceContractConsentPolicy[];
  scenarioFixtures?: SourceContractScenarioFixture[];
  behaviorProfiles?: SourceContractBehaviorProfile[];
  optionalExternalAgents: string[];
  confidence: number;
}

interface SourceFileLike {
  name: string;
  resolvedText?: string | null;
  content?: Buffer | Uint8Array | string | null;
}

const AGENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(?:[./-][a-zA-Z_][a-zA-Z0-9_]*)*$/;
const MAX_RULES = 24;
const SIDE_EFFECT_TOOL_PATTERN =
  /\b(apply|approve|assign|book|cancel|charge|close|create|delete|execute|finalize|initiate|issue|provision|refund|replace|replacement|request|schedule|send|submit|transfer|update|write)\b/i;
const READ_ONLY_TOOL_PREFIX_PATTERN =
  /^(authenticate|calculate|check|classify|diagnose|fetch|find|get|list|load|lookup|parse|read|screen|score|search|validate|verify)(_|$)/i;
const CONSENT_SCOPE_PRIORITY = [
  'order_id',
  'invoice_id',
  'account_id',
  'customer_id',
  'case_id',
  'ticket_id',
  'transaction_id',
  'payment_id',
  'refund_amount',
  'credit_amount',
  'replacement_sku',
  'amount',
];

function cleanText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanIdentifier(value: string): string {
  return value.replace(/[`*]/g, '').trim();
}

function normalizeToolKey(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function maybeStringArray(values: readonly string[]): string[] | undefined {
  return values.length > 0 ? [...values] : undefined;
}

function uniqueBy<T>(values: readonly T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyFor(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function fileText(file: SourceFileLike): string {
  if (typeof file.resolvedText === 'string' && file.resolvedText.trim().length > 0) {
    return file.resolvedText;
  }
  if (typeof file.content === 'string') return file.content;
  if (file.content instanceof Uint8Array) return Buffer.from(file.content).toString('utf8');
  return '';
}

function extractBehaviorProfiles(text: string, fileName: string): SourceContractBehaviorProfile[] {
  const starts = [...text.matchAll(/^\s*BEHAVIOR_PROFILE:\s*([A-Za-z_][A-Za-z0-9_-]*)\s*$/gm)];
  if (starts.length === 0) return [];

  return starts.flatMap<SourceContractBehaviorProfile>((match, index) => {
    const name = match[1];
    if (!name) return [];

    const start = match.index ?? 0;
    const nextStart = findNextBehaviorProfileBoundary(text, starts, index, start);
    const dslContent = `${text.slice(start, nextStart).trim()}\n`;
    return [
      {
        name,
        dslContent,
        provenance: { fileName, section: `BEHAVIOR_PROFILE:${name}` },
      },
    ];
  });
}

function findNextBehaviorProfileBoundary(
  text: string,
  starts: RegExpMatchArray[],
  currentIndex: number,
  currentStart: number,
): number {
  const nextProfileStart = starts[currentIndex + 1]?.index ?? text.length;
  const nextTopLevelDslBlock = /^\s*(?:AGENT|MODULE|TOOL|MCP_SERVER|CHANNEL):\s*\S+/gm;
  nextTopLevelDslBlock.lastIndex = currentStart + 1;
  const nextBlock = nextTopLevelDslBlock.exec(text);
  return Math.min(nextProfileStart, nextBlock?.index ?? text.length);
}

function parseMarkdownTable(lines: string[], startIndex: number): string[][] {
  const rows: string[][] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('|') || !line.endsWith('|')) break;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cleanText(cell));
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

function sectionForHeading(
  text: string,
  headingPattern: RegExp,
): { title: string; body: string } | null {
  const headingRegex = /^(#{2,5})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(text)) !== null) {
    const marker = match[1] ?? '##';
    const title = cleanText(match[2] ?? '');
    if (!headingPattern.test(title)) continue;
    const start = headingRegex.lastIndex;
    const nextHeadingRegex = new RegExp(`^#{2,${marker.length}}\\s+`, 'gm');
    nextHeadingRegex.lastIndex = start;
    const next = nextHeadingRegex.exec(text);
    return {
      title,
      body: text.slice(start, next?.index ?? text.length),
    };
  }
  return null;
}

function extractNumberBefore(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseSignatureParamNames(signature: string | undefined): string[] {
  if (!signature) return [];
  const params = signature.match(/\(([^)]*)\)/)?.[1];
  if (!params) return [];
  return params
    .split(',')
    .map((param) => param.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:?\s*/)?.[1])
    .filter((name): name is string => Boolean(name));
}

function toolGuidanceColumn(header: readonly string[], pattern: RegExp): number {
  return header.findIndex((cell) =>
    pattern.test(cell.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()),
  );
}

function parseToolGuidanceCell(value: string | undefined): string[] {
  if (!value) return [];
  const cleaned = cleanText(value);
  if (!cleaned) return [];
  return unique(
    cleaned
      .split(/(?:\s*;\s*)|(?:\s*\|\s*)|(?:\s+•\s+)|(?:\s+-\s+)/)
      .map((item) =>
        item
          .replace(/^(?:call|use)\s+when\s*:?\s*/i, '')
          .replace(/^(?:do\s+not|don't|avoid)\s+(?:call|use)?\s*(?:when)?\s*:?\s*/i, '')
          .trim(),
      )
      .filter((item) => item.length > 0),
  );
}

function isSideEffectingTool(tool: SourceContractTool): boolean {
  const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
  if (READ_ONLY_TOOL_PREFIX_PATTERN.test(tool.name)) {
    return SIDE_EFFECT_TOOL_PATTERN.test(text) && !/^get|lookup|search|fetch|list/i.test(tool.name);
  }
  return SIDE_EFFECT_TOOL_PATTERN.test(text);
}

function inferConsentAction(tool: SourceContractTool): string {
  const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
  if (/\b(replacement|replace|resend)\b/.test(text)) return 'replacement';
  if (/\brefund\b/.test(text)) return 'refund';
  if (/\bcredit\b/.test(text)) return 'credit';
  if (/\b(charge|payment|pay)\b/.test(text)) return 'payment';
  if (/\b(book|booking|reservation|appointment|schedule)\b/.test(text)) return 'booking';
  if (/\bcancel\b/.test(text)) return 'cancellation';
  return tool.name.replace(/_/g, ' ');
}

function inferConsentScope(tool: SourceContractTool): string[] {
  const params = parseSignatureParamNames(tool.signature);
  return CONSENT_SCOPE_PRIORITY.filter((field) => params.includes(field));
}

function extractAgentRoster(text: string, fileName: string): SourceContractAgent[] {
  const lines = text.split(/\r?\n/);
  const agents: SourceContractAgent[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('|')) continue;
    const table = parseMarkdownTable(lines, index);
    if (table.length < 2) continue;
    const header = table[0] ?? [];
    const agentColumn = header.findIndex((cell) => /^agent$/i.test(cell));
    const roleColumn = header.findIndex((cell) => /^role$/i.test(cell));
    if (agentColumn < 0 || roleColumn < 0) continue;

    for (const row of table.slice(1)) {
      const name = cleanIdentifier(row[agentColumn] ?? '');
      if (!AGENT_NAME_PATTERN.test(name)) continue;
      agents.push({
        name,
        role: cleanText(row[roleColumn] ?? ''),
        tools: [],
        memoryVariables: [],
        limitations: [],
        provenance: { fileName, section: 'Agent roster' },
      });
    }
    index += table.length - 1;
  }

  const existingNames = new Set(agents.map((agent) => agent.name));
  for (const match of text.matchAll(/^\s*(?:AGENT|SUPERVISOR):\s*([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const name = match[1];
    if (!name || existingNames.has(name)) continue;
    existingNames.add(name);
    agents.push({
      name,
      role: `${name} agent`,
      tools: [],
      memoryVariables: [],
      limitations: [],
      provenance: { fileName, section: 'ABL agent declaration' },
    });
  }

  return agents;
}

function sectionRanges(text: string): Array<{ title: string; body: string }> {
  const headingRegex = /^##\s+(.+)$/gm;
  const headings: Array<{ title: string; index: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(text)) !== null) {
    headings.push({
      title: cleanText(match[1] ?? ''),
      index: match.index,
      end: headingRegex.lastIndex,
    });
  }

  return headings.map((heading, index) => {
    const next = headings[index + 1]?.index ?? text.length;
    return {
      title: heading.title,
      body: text.slice(heading.end, next),
    };
  });
}

function extractBacktickedIdentifiers(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const raw = cleanIdentifier(match[1] ?? '');
    const name = raw.split(/[,(]/)[0]?.trim() ?? '';
    if (TOOL_NAME_PATTERN.test(name)) result.push(name);
  }
  return unique(result);
}

function extractListAfterHeading(sectionBody: string, heading: string): string[] {
  const regex = new RegExp(`^#{3,5}\\s+[^\\n]*${heading}[^\\n]*$`, 'gim');
  const match = regex.exec(sectionBody);
  if (!match) return [];
  const start = match.index + match[0].length;
  const rest = sectionBody.slice(start);
  const nextHeading = rest.search(/^#{2,5}\s+/m);
  const block = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  return extractBacktickedIdentifiers(block);
}

function extractAgentDetails(
  text: string,
  fileName: string,
  roster: SourceContractAgent[],
): SourceContractAgent[] {
  const byName = new Map(roster.map((agent) => [agent.name, { ...agent }]));

  for (const section of sectionRanges(text)) {
    const matchedAgent = roster.find((agent) => section.title.includes(agent.name));
    if (!matchedAgent) continue;
    const current = byName.get(matchedAgent.name) ?? matchedAgent;
    const description = section.body.match(/\*\*Description:\*\*\s*([^\n]+)/i)?.[1];
    const tools = extractListAfterHeading(section.body, 'Tools');
    const memoryVariables = extractListAfterHeading(section.body, 'Memory');
    const limitationsBlock =
      section.body.match(/#{3,5}\s+[^#\n]*Limitations[^#]*?(?=\n#{2,5}\s+|$)/is)?.[0] ?? '';
    const limitations = limitationsBlock
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1])
      .filter((value): value is string => typeof value === 'string')
      .map(cleanText);

    byName.set(current.name, {
      ...current,
      role: current.role || cleanText(description ?? ''),
      tools: unique([...current.tools, ...tools]),
      memoryVariables: unique([...current.memoryVariables, ...memoryVariables]),
      limitations: unique([...current.limitations, ...limitations]),
      provenance: { fileName, section: section.title },
    });
  }

  return Array.from(byName.values());
}

function extractEntryAgent(text: string): string | undefined {
  const patterns = [
    /\bentry\s+agent\b\s*[:=]\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/i,
    /\bentry\s+point\b\s*[:=]\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/i,
    /\bset\s+entry\s+agent\b\s*=\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanIdentifier(match[1]);
  }
  return undefined;
}

function extractChannels(text: string): string[] {
  const match = text.match(/\bchannels?\b\s*[:=]\s*([^\n]+)/i);
  if (!match?.[1]) return [];
  return unique(
    match[1]
      .split(/[,;/]|(?:\band\b)/i)
      .map(cleanText)
      .filter((value) => value.length > 0),
  );
}

function extractRequiredMcpServers(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9 -]+?)\s+MCP\b/g)) {
    result.push(cleanText(`${match[1]} MCP`));
  }
  for (const match of text.matchAll(/\bMCP\s+server\b[^.\n:]*[:=]?\s*([A-Z][A-Za-z0-9 -]+)/gi)) {
    result.push(cleanText(match[1] ?? ''));
  }
  return unique(result);
}

function extractToolCatalog(text: string, fileName: string): SourceContractTool[] {
  const tools: SourceContractTool[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('|')) continue;
    const table = parseMarkdownTable(lines, index);
    if (table.length < 2) continue;
    const header = table[0] ?? [];
    const toolColumn = header.findIndex((cell) => /^tool$/i.test(cell));
    const signatureColumn = header.findIndex((cell) => /^signature$/i.test(cell));
    const descriptionColumn = header.findIndex((cell) => /^description$/i.test(cell));
    const callWhenColumn = toolGuidanceColumn(
      header,
      /^(?:call\s+when|when\s+to\s+call|use\s+when|call\s+triggers?|call_when)$/i,
    );
    const doNotCallWhenColumn = toolGuidanceColumn(
      header,
      /^(?:do\s+not\s+call\s+when|don't\s+call\s+when|do\s+not\s+use\s+when|avoid\s+when|do_not_call_when)$/i,
    );
    if (toolColumn < 0) continue;

    for (const row of table.slice(1)) {
      const name = cleanIdentifier(row[toolColumn] ?? '');
      if (!TOOL_NAME_PATTERN.test(name)) continue;
      const callWhen = callWhenColumn >= 0 ? parseToolGuidanceCell(row[callWhenColumn] ?? '') : [];
      const doNotCallWhen =
        doNotCallWhenColumn >= 0 ? parseToolGuidanceCell(row[doNotCallWhenColumn] ?? '') : [];
      tools.push({
        name,
        signature: signatureColumn >= 0 ? cleanText(row[signatureColumn] ?? '') : undefined,
        description: descriptionColumn >= 0 ? cleanText(row[descriptionColumn] ?? '') : undefined,
        ...(callWhen.length > 0 ? { callWhen } : {}),
        ...(doNotCallWhen.length > 0 ? { doNotCallWhen } : {}),
        provenance: { fileName, section: 'Tool catalog' },
      });
    }
    index += table.length - 1;
  }
  return tools;
}

function extractUniversalRules(text: string): string[] {
  const rules: string[] = [];
  const section =
    text.match(
      /#{2,4}\s+[^#\n]*(universal|global)[^#\n]*(rules|behavior|state)[\s\S]*?(?=\n#{2,4}\s+|$)/i,
    )?.[0] ?? '';
  for (const line of section.split(/\r?\n/)) {
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)?.[1];
    if (item) rules.push(cleanText(item));
  }
  return unique(rules).slice(0, MAX_RULES);
}

function extractGuardrails(text: string): string[] {
  const section = text.match(/#{2,4}\s+[^#\n]*guardrails?[\s\S]*?(?=\n#{2,4}\s+|$)/i)?.[0] ?? '';
  return unique(
    section
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)?.[1])
      .filter((value): value is string => typeof value === 'string')
      .map(cleanText),
  ).slice(0, MAX_RULES);
}

function extractOptionalExternalAgents(text: string): string[] {
  const section =
    text.match(/#{2,4}\s+[^#\n]*(external|federation|optional)[\s\S]*?(?=\n#{2,4}\s+|$)/i)?.[0] ??
    '';
  return unique(extractBacktickedIdentifiers(section).filter((name) => /agent$/i.test(name)));
}

function withAgentModelPolicies(
  agents: readonly SourceContractAgent[],
  entryAgent?: string,
): SourceContractAgent[] {
  return agents.map((agent) => ({
    ...agent,
    modelPolicy: inferArchModelPolicyFromText({
      name: agent.name,
      role: agent.role,
      description: agent.role,
      executionMode: modeForAgent(agent, entryAgent),
      isEntryPoint: agent.name === entryAgent,
      hasOutgoingEdges: agent.name === entryAgent,
    }),
  }));
}

function extractWelcomeShape(
  text: string,
  fileName: string,
): SourceContractWelcomeShape | undefined {
  const section = sectionForHeading(text, /welcome|greeting|customer experience|persona/i);
  const source = section?.body ?? text;
  const openingLine =
    source.match(/\b(?:welcome|greeting|opening(?:\s+line)?)\b\s*[:=]\s*"([^"]+)"/i)?.[1] ??
    source.match(/\b(?:welcome|greeting|opening(?:\s+line)?)\b\s*[:=]\s*([^\n]+)/i)?.[1];
  const personaName =
    source.match(/\bperceived\s+persona\s+name\s*[:=]\s*"?([^"\n]+)"?/i)?.[1] ??
    source.match(
      /\b(?:perceived\s+)?(?:persona|agent|voice)\b\s*(?:name|as|is|=|:)\s*"?([A-Z][A-Za-z0-9 _-]{1,40})"?/i,
    )?.[1] ??
    source.match(/\bnamed\s+"?([A-Z][A-Za-z0-9 _-]{1,40})"?/i)?.[1];
  const voiceMaxWords = extractNumberBefore(
    source,
    /\bvoice\b[^\n.]{0,80}?(?:max|under|<=|no more than)\s*(\d+)\s*words?/i,
  );
  const chatMaxWords = extractNumberBefore(
    source,
    /\b(?:chat|web)\b[^\n.]{0,80}?(?:max|under|<=|no more than)\s*(\d+)\s*words?/i,
  );
  const continuity =
    /\b(single|same|shared|continuous)\b[^\n.]{0,80}\b(?:voice|persona|agent)\b/i.test(source)
      ? 'single_perceived_agent'
      : /\b(agent-specific|specialist\s+introduces|announce\s+transfer)\b/i.test(source)
        ? 'agent_specific'
        : 'unspecified';

  if (!section && !openingLine && !personaName && !voiceMaxWords && !chatMaxWords) {
    return undefined;
  }

  return {
    ...(personaName ? { personaName: cleanText(personaName) } : {}),
    ...(openingLine ? { openingLine: cleanText(openingLine) } : {}),
    ...(voiceMaxWords ? { voiceMaxWords } : {}),
    ...(chatMaxWords ? { chatMaxWords } : {}),
    continuity,
    provenance: { fileName, section: section?.title ?? 'Customer experience hints' },
  };
}

function defaultChannelRule(channel: string, fileName: string): SourceContractChannelRule {
  const normalized = channel.toLowerCase();
  if (/\bvoice|phone|sip|call\b/.test(normalized)) {
    return {
      channel,
      welcomeMaxWords: 18,
      responseMaxWords: 45,
      abbreviationPolicy: 'expand_for_voice',
      toolLatencyBridge: true,
      requiresRecordingConsent: /\brecord/.test(normalized),
      rules: [],
      provenance: { fileName, section: 'Channels' },
    };
  }
  if (/\bsms|whatsapp|text\b/.test(normalized)) {
    return {
      channel,
      welcomeMaxWords: 20,
      responseMaxWords: 35,
      abbreviationPolicy: 'preserve_text',
      requiresTemplate: /\bwhatsapp\b/.test(normalized),
      rules: [],
      provenance: { fileName, section: 'Channels' },
    };
  }
  return {
    channel,
    welcomeMaxWords: 30,
    responseMaxWords: 80,
    abbreviationPolicy: 'preserve_text',
    rules: [],
    provenance: { fileName, section: 'Channels' },
  };
}

function extractChannelRules(
  text: string,
  fileName: string,
  channels: readonly string[],
): SourceContractChannelRule[] {
  const rules = new Map(
    channels.map((channel) => [channel.toLowerCase(), defaultChannelRule(channel, fileName)]),
  );
  const section = sectionForHeading(text, /channel|voice|chat|sms|whatsapp/i);
  if (!section) return Array.from(rules.values());

  for (const line of section.body.split(/\r?\n/)) {
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)?.[1];
    if (!item) continue;
    const cleaned = cleanText(item);
    const channel =
      channels.find((candidate) =>
        new RegExp(`\\b${escapeRegExp(candidate)}\\b`, 'i').test(cleaned),
      ) ?? cleaned.match(/^(voice|web chat|chat|sms|whatsapp|email)\b/i)?.[1];
    if (!channel) continue;
    const key = channel.toLowerCase();
    const existing = rules.get(key) ?? defaultChannelRule(channel, fileName);
    rules.set(key, {
      ...existing,
      welcomeMaxWords:
        extractNumberBefore(
          cleaned,
          /\b(?:welcome|greeting)\b[^\n.]{0,80}?(?:max|under|<=|no more than)\s*(\d+)\s*words?/i,
        ) ?? existing.welcomeMaxWords,
      responseMaxWords:
        extractNumberBefore(
          cleaned,
          /\b(?:responses?|answers?|replies)\b[^\n.]{0,80}?(?:max|under|<=|no more than)\s*(\d+)\s*words?/i,
        ) ?? existing.responseMaxWords,
      toolLatencyBridge: /\b(?:bridge|status|typing|latency|wait)\b/i.test(cleaned)
        ? true
        : existing.toolLatencyBridge,
      requiresTemplate: /\btemplate\b/i.test(cleaned) ? true : existing.requiresTemplate,
      requiresRecordingConsent: /\brecord(?:ing)?\s+consent\b/i.test(cleaned)
        ? true
        : existing.requiresRecordingConsent,
      rules: unique([...existing.rules, cleaned]),
      provenance: { fileName, section: section.title },
    });
  }

  return Array.from(rules.values());
}

function extractConsentPolicies(
  text: string,
  fileName: string,
  tools: readonly SourceContractTool[],
): SourceContractConsentPolicy[] {
  const section = sectionForHeading(text, /consent|confirmation|side effects?|write actions?/i);
  const sectionRules = section
    ? section.body
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)?.[1])
        .filter((value): value is string => typeof value === 'string')
        .map(cleanText)
    : [];
  const policies = tools.filter(isSideEffectingTool).map(
    (tool): SourceContractConsentPolicy => ({
      toolName: tool.name,
      action: inferConsentAction(tool),
      mode: 'when_side_effects',
      requiredIn: sectionRules.some((rule) => /\bexplicit\s+prompt\b/i.test(rule))
        ? 'explicit_prompt'
        : 'conversation',
      scopeFields: inferConsentScope(tool),
      fallback: sectionRules.some((rule) => /\bblock\b/i.test(rule)) ? 'block' : 'explicit_prompt',
      provenance: { fileName, section: section?.title ?? 'Tool catalog' },
    }),
  );

  if (policies.length > 0 || sectionRules.length === 0) return policies;
  return [
    {
      action: 'side effecting action',
      mode: 'when_side_effects',
      requiredIn: sectionRules.some((rule) => /\bexplicit\s+prompt\b/i.test(rule))
        ? 'explicit_prompt'
        : 'conversation',
      scopeFields: [],
      fallback: sectionRules.some((rule) => /\bblock\b/i.test(rule)) ? 'block' : 'explicit_prompt',
      provenance: { fileName, section: section?.title ?? 'Consent policy' },
    },
  ];
}

function extractScenarioFixtures(text: string, fileName: string): SourceContractScenarioFixture[] {
  const fixtures: SourceContractScenarioFixture[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('|')) continue;
    const table = parseMarkdownTable(lines, index);
    if (table.length < 2) continue;
    const header = table[0] ?? [];
    const scenarioColumn = header.findIndex((cell) => /^(scenario|fixture|case)$/i.test(cell));
    const inputColumn = header.findIndex((cell) => /^(input|user message|utterance)$/i.test(cell));
    if (scenarioColumn < 0 || inputColumn < 0) continue;
    const channelColumn = header.findIndex((cell) => /^channel$/i.test(cell));
    const expectedColumn = header.findIndex((cell) =>
      /^(expected|expected outcome|outcome)$/i.test(cell),
    );
    const toolsColumn = header.findIndex((cell) =>
      /^(tool|tool fixtures?|tool responses?)$/i.test(cell),
    );

    for (const row of table.slice(1)) {
      const name = cleanText(row[scenarioColumn] ?? '');
      const userMessage = cleanText(row[inputColumn] ?? '');
      if (!name || !userMessage) continue;
      const toolFixtures = toolsColumn >= 0 ? parseToolFixtureCell(row[toolsColumn] ?? '') : [];
      fixtures.push({
        name,
        ...(channelColumn >= 0 && row[channelColumn]
          ? { channel: cleanText(row[channelColumn] ?? '') }
          : {}),
        userMessage,
        ...(expectedColumn >= 0 && row[expectedColumn]
          ? { expectedOutcome: cleanText(row[expectedColumn] ?? '') }
          : {}),
        toolFixtures,
        provenance: { fileName, section: 'Scenario fixtures' },
      });
    }
    index += table.length - 1;
  }
  return uniqueBy(fixtures, (fixture) => `${fixture.name}:${fixture.userMessage}`);
}

function parseToolFixtureCell(value: string): SourceContractScenarioFixture['toolFixtures'] {
  const cleaned = cleanText(value);
  if (!cleaned) return [];
  return cleaned
    .split(/;+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const inputMatch = item.match(
        /^([A-Za-z_][A-Za-z0-9_]*(?:[./-][A-Za-z_][A-Za-z0-9_]*)*)\s*\((\{.*\})\)\s*(?:=>|:)\s*(.+)$/s,
      );
      if (inputMatch?.[1] && inputMatch[2] && inputMatch[3]) {
        return {
          toolName: cleanIdentifier(inputMatch[1]),
          sampleInput: parseFixtureSampleInput(inputMatch[2]),
          response: cleanText(inputMatch[3] || 'fixture response supplied by source'),
        };
      }

      const namedInputMatch = item.match(
        /^([A-Za-z_][A-Za-z0-9_]*(?:[./-][A-Za-z_][A-Za-z0-9_]*)*)\s+input\s*=\s*(\{.*\})\s*(?:=>|:)\s*(.+)$/s,
      );
      if (namedInputMatch?.[1] && namedInputMatch[2] && namedInputMatch[3]) {
        return {
          toolName: cleanIdentifier(namedInputMatch[1]),
          sampleInput: parseFixtureSampleInput(namedInputMatch[2]),
          response: cleanText(namedInputMatch[3] || 'fixture response supplied by source'),
        };
      }

      const [toolName, ...responseParts] = item.split(/=>|:/);
      return {
        toolName: cleanIdentifier(toolName ?? ''),
        response: cleanText(responseParts.join(':') || 'fixture response supplied by source'),
      };
    })
    .filter((item) => TOOL_NAME_PATTERN.test(item.toolName));
}

function parseFixtureSampleInput(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function mergeContracts(
  contracts: SourceArchitectureContract[],
): SourceArchitectureContract | null {
  if (contracts.length === 0) return null;
  const declaredAgents = new Map<string, SourceContractAgent>();
  const tools = new Map<string, SourceContractTool>();

  for (const contract of contracts) {
    for (const agent of contract.declaredAgents) {
      const existing = declaredAgents.get(agent.name);
      declaredAgents.set(agent.name, {
        ...agent,
        role: agent.role || existing?.role || '',
        tools: unique([...(existing?.tools ?? []), ...agent.tools]),
        memoryVariables: unique([...(existing?.memoryVariables ?? []), ...agent.memoryVariables]),
        limitations: unique([...(existing?.limitations ?? []), ...agent.limitations]),
        modelPolicy: agent.modelPolicy ?? existing?.modelPolicy,
      });
    }
    for (const tool of contract.tools) {
      const key = normalizeToolKey(tool.name);
      const existing = tools.get(key);
      const callWhen = unique([...(existing?.callWhen ?? []), ...(tool.callWhen ?? [])]);
      const doNotCallWhen = unique([
        ...(existing?.doNotCallWhen ?? []),
        ...(tool.doNotCallWhen ?? []),
      ]);
      tools.set(key, {
        ...existing,
        ...tool,
        name: existing?.name ?? tool.name,
        ...(maybeStringArray(callWhen) ? { callWhen } : {}),
        ...(maybeStringArray(doNotCallWhen) ? { doNotCallWhen } : {}),
      });
    }
  }

  const firstEntry = contracts.find((contract) => contract.entryAgent)?.entryAgent;
  const sharedMemory = unique([
    ...contracts.flatMap((contract) => contract.sharedMemoryVariables),
    ...Array.from(declaredAgents.values()).flatMap((agent) => agent.memoryVariables),
  ]);

  return {
    sourceFiles: unique(contracts.flatMap((contract) => contract.sourceFiles)),
    declaredAgents: Array.from(declaredAgents.values()),
    entryAgent: firstEntry,
    channels: unique(contracts.flatMap((contract) => contract.channels)),
    requiredMcpServers: unique(contracts.flatMap((contract) => contract.requiredMcpServers)),
    sharedMemoryVariables: sharedMemory,
    universalRules: unique(contracts.flatMap((contract) => contract.universalRules)).slice(
      0,
      MAX_RULES,
    ),
    guardrails: unique(contracts.flatMap((contract) => contract.guardrails)).slice(0, MAX_RULES),
    tools: Array.from(tools.values()),
    welcomeShape: contracts.find((contract) => contract.welcomeShape)?.welcomeShape,
    channelRules: uniqueBy(
      contracts.flatMap((contract) => contract.channelRules ?? []),
      (rule) => rule.channel.toLowerCase(),
    ),
    consentPolicies: uniqueBy(
      contracts.flatMap((contract) => contract.consentPolicies ?? []),
      (policy) => `${policy.toolName ? normalizeToolKey(policy.toolName) : '*'}:${policy.action}`,
    ),
    scenarioFixtures: uniqueBy(
      contracts.flatMap((contract) => contract.scenarioFixtures ?? []),
      (fixture) => `${fixture.name}:${fixture.userMessage}`,
    ),
    behaviorProfiles: uniqueBy(
      contracts.flatMap((contract) => contract.behaviorProfiles ?? []),
      (profile) => profile.name,
    ),
    optionalExternalAgents: unique(
      contracts.flatMap((contract) => contract.optionalExternalAgents),
    ),
    confidence: Math.max(...contracts.map((contract) => contract.confidence)),
  };
}

export function extractSourceArchitectureContractFromText(
  text: string,
  fileName: string,
): SourceArchitectureContract | null {
  const roster = extractAgentRoster(text, fileName);
  const entryAgent = extractEntryAgent(text);
  const declaredAgents = withAgentModelPolicies(
    extractAgentDetails(text, fileName, roster),
    entryAgent,
  );
  const tools = extractToolCatalog(text, fileName);
  const channels = extractChannels(text);
  const behaviorProfiles = extractBehaviorProfiles(text, fileName);
  const sharedMemoryVariables = unique(
    extractBacktickedIdentifiers(text).filter((name) => /_id$|^intent$/.test(name)),
  );

  if (declaredAgents.length === 0 && tools.length === 0 && behaviorProfiles.length === 0) {
    return null;
  }

  return {
    sourceFiles: [fileName],
    declaredAgents,
    entryAgent,
    channels,
    requiredMcpServers: extractRequiredMcpServers(text),
    sharedMemoryVariables,
    universalRules: extractUniversalRules(text),
    guardrails: extractGuardrails(text),
    tools,
    welcomeShape: extractWelcomeShape(text, fileName),
    channelRules: extractChannelRules(text, fileName, channels),
    consentPolicies: extractConsentPolicies(text, fileName, tools),
    scenarioFixtures: extractScenarioFixtures(text, fileName),
    ...(behaviorProfiles.length > 0 ? { behaviorProfiles } : {}),
    optionalExternalAgents: extractOptionalExternalAgents(text),
    confidence: declaredAgents.length >= 2 ? 0.95 : behaviorProfiles.length > 0 ? 0.8 : 0.65,
  };
}

export function extractSourceArchitectureContractFromFiles(
  files: readonly SourceFileLike[],
): SourceArchitectureContract | null {
  return mergeContracts(
    files
      .map((file) => extractSourceArchitectureContractFromText(fileText(file), file.name))
      .filter((contract): contract is SourceArchitectureContract => contract !== null),
  );
}

export function getSourceArchitectureContractFromMetadata(
  metadata: Record<string, unknown> | undefined,
): SourceArchitectureContract | null {
  const value = metadata?.sourceArchitectureContract;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const contract = value as SourceArchitectureContract;
  const hasAgents = Array.isArray(contract.declaredAgents) && contract.declaredAgents.length > 0;
  const hasTools = Array.isArray(contract.tools) && contract.tools.length > 0;
  const hasFixtures =
    Array.isArray(contract.scenarioFixtures) && contract.scenarioFixtures.length > 0;
  const hasProfiles =
    Array.isArray(contract.behaviorProfiles) && contract.behaviorProfiles.length > 0;
  return hasAgents || hasTools || hasFixtures || hasProfiles ? contract : null;
}

function modeForAgent(
  agent: SourceContractAgent,
  entryAgent?: string,
): 'reasoning' | 'scripted' | 'hybrid' {
  const text = `${agent.name} ${agent.role}`.toLowerCase();
  if (entryAgent === agent.name || /supervisor|router|triage|coordinator/.test(text))
    return 'hybrid';
  if (/application|payment|transfer|loan|escalation/.test(text) || agent.tools.length > 0)
    return 'hybrid';
  return 'reasoning';
}

function isSilentDelegateAgent(agent: SourceContractAgent): boolean {
  const text = `${agent.name} ${agent.role}`.toLowerCase();
  return (
    /\b(internal|silent|back[-\s]?office|advisor|advisory|eligibility|analysis|planner)\b/.test(
      text,
    ) && !/\b(human|escalation|representative|customer[-\s]?facing)\b/.test(text)
  );
}

export function synthesizeTopologyFromSourceContract(
  contract: SourceArchitectureContract,
): TopologyOutput | null {
  if (contract.declaredAgents.length === 0) return null;
  const entryPoint = contract.entryAgent ?? contract.declaredAgents[0]!.name;
  const agents = contract.declaredAgents.map((agent) => ({
    name: agent.name,
    role: agent.role || `${agent.name} specialist`,
    executionMode: modeForAgent(agent, entryPoint),
    description: agent.role || `${agent.name} responsibilities from uploaded source documents.`,
    modelPolicy:
      agent.modelPolicy ??
      inferArchModelPolicyFromText({
        name: agent.name,
        role: agent.role,
        description: agent.role || `${agent.name} responsibilities from uploaded source documents.`,
        executionMode: modeForAgent(agent, entryPoint),
        isEntryPoint: agent.name === entryPoint,
        hasOutgoingEdges: agent.name === entryPoint,
      }),
    tools: agent.tools.length > 0 ? agent.tools : undefined,
    gatherFields: undefined,
    flowStepSeeds:
      agent.tools.length > 0
        ? ['load_context', 'collect_required_fields', 'confirm_if_needed', 'complete_or_return']
        : undefined,
    suggestedConstructs: unique([
      'GATHER',
      ...(agent.tools.length > 0 ? ['TOOLS', 'FLOW'] : []),
      agent.name === entryPoint ? 'HANDOFF' : 'COMPLETE',
    ]),
  }));

  const edges = contract.declaredAgents
    .filter((agent) => agent.name !== entryPoint)
    .map((agent) => {
      const isHumanEscalation = /human|escalation/i.test(agent.name);
      const isSilentDelegate = !isHumanEscalation && isSilentDelegateAgent(agent);
      return {
        from: entryPoint,
        to: agent.name,
        type: isHumanEscalation
          ? ('escalate' as const)
          : isSilentDelegate
            ? ('delegate' as const)
            : ('transfer' as const),
        condition: isHumanEscalation
          ? 'user_requests_human == true OR negative_sentiment == true'
          : isSilentDelegate
            ? `${agent.name.replace(/Agent$/i, '').toLowerCase()}_needed == true`
            : `${agent.name.replace(/Agent$/i, '').toLowerCase()}_intent == true`,
        expectReturn: !isHumanEscalation,
        experienceMode: isHumanEscalation
          ? ('human_escalation' as const)
          : isSilentDelegate
            ? ('silent_delegate' as const)
            : ('shared_voice_handoff' as const),
      };
    });

  return { agents, edges, entryPoint };
}

export function validateTopologyAgainstSourceContract(
  topology: TopologyOutput,
  contract: SourceArchitectureContract | null,
): string | null {
  if (!contract || contract.declaredAgents.length === 0) return null;

  const actualNames = new Set(topology.agents.map((agent) => agent.name));
  const missingAgents = contract.declaredAgents
    .map((agent) => agent.name)
    .filter((name) => !actualNames.has(name));
  if (missingAgents.length > 0) {
    return (
      `Error: uploaded source documents declare ${contract.declaredAgents.length} agents, ` +
      `but the topology is missing ${missingAgents.join(', ')}. Preserve exact source agent names; do not merge, rename, or simplify declared agents unless the user explicitly asked to simplify.`
    );
  }

  if (contract.entryAgent && topology.entryPoint !== contract.entryAgent) {
    return `Error: uploaded source documents set entry agent "${contract.entryAgent}", but topology entryPoint is "${topology.entryPoint}". Use the source entry agent exactly.`;
  }

  const agentByName = new Map(topology.agents.map((agent) => [agent.name, agent]));
  const missingTools = contract.declaredAgents.flatMap((agent) => {
    if (agent.tools.length === 0) return [];
    const actualTools = new Set(agentByName.get(agent.name)?.tools ?? []);
    return agent.tools
      .filter((tool) => !actualTools.has(tool))
      .map((tool) => `${agent.name}.${tool}`);
  });
  if (missingTools.length > 0) {
    return (
      `Error: topology dropped tools declared by uploaded source documents: ${missingTools.slice(0, 20).join(', ')}. ` +
      'Carry declared tools forward on the owning agents. If backing is unknown, keep the callable name and mark integration readiness later.'
    );
  }

  if (contract.entryAgent) {
    const edgeTargets = new Set(
      topology.edges.filter((edge) => edge.from === contract.entryAgent).map((edge) => edge.to),
    );
    const unreachableDeclared = contract.declaredAgents
      .filter((agent) => agent.name !== contract.entryAgent)
      .filter((agent) => !edgeTargets.has(agent.name))
      .map((agent) => agent.name);
    if (unreachableDeclared.length > 0) {
      return `Error: source-declared agents are not reachable from entry agent "${contract.entryAgent}": ${unreachableDeclared.join(', ')}. Add delegate/escalate edges from the supervisor or explain an explicit routing path.`;
    }
  }

  return null;
}

export function renderSourceArchitectureContractPrompt(
  contract: SourceArchitectureContract | null,
): string {
  if (!contract || contract.declaredAgents.length === 0) return '';
  const lines: string[] = [];
  lines.push('## Uploaded Source Architecture Contract');
  lines.push(
    'The uploaded documents contain an explicit architecture. Treat this as authoritative unless the user explicitly asked to simplify.',
  );
  lines.push(`Source files: ${contract.sourceFiles.join(', ')}`);
  if (contract.entryAgent) lines.push(`Entry agent: ${contract.entryAgent}`);
  if (contract.channels.length > 0) lines.push(`Channels: ${contract.channels.join(', ')}`);
  if (contract.welcomeShape) {
    const welcome = contract.welcomeShape;
    lines.push(
      [
        'Welcome/customer experience:',
        welcome.personaName ? `persona=${welcome.personaName}` : '',
        welcome.openingLine ? `opening=${JSON.stringify(welcome.openingLine)}` : '',
        welcome.voiceMaxWords ? `voiceMaxWords=${welcome.voiceMaxWords}` : '',
        welcome.chatMaxWords ? `chatMaxWords=${welcome.chatMaxWords}` : '',
        `continuity=${welcome.continuity}`,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
  if ((contract.channelRules ?? []).length > 0) {
    lines.push('Channel rules:');
    for (const rule of (contract.channelRules ?? []).slice(0, 8)) {
      const limits = [
        rule.welcomeMaxWords ? `welcome<=${rule.welcomeMaxWords} words` : '',
        rule.responseMaxWords ? `response<=${rule.responseMaxWords} words` : '',
        rule.abbreviationPolicy ? `abbrev=${rule.abbreviationPolicy}` : '',
        rule.toolLatencyBridge ? 'bridge_tool_latency=true' : '',
        rule.requiresTemplate ? 'template_required=true' : '',
        rule.requiresRecordingConsent ? 'recording_consent=true' : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- ${rule.channel}${limits ? `: ${limits}` : ''}`);
      for (const item of rule.rules.slice(0, 2)) lines.push(`  - ${item}`);
    }
  }
  if (contract.requiredMcpServers.length > 0) {
    lines.push(`Required MCP/tools: ${contract.requiredMcpServers.join(', ')}`);
  }
  lines.push('Declared agents to preserve exactly:');
  for (const agent of contract.declaredAgents) {
    const tools = agent.tools.length > 0 ? ` tools=[${agent.tools.join(', ')}]` : '';
    const memory =
      agent.memoryVariables.length > 0 ? ` memory=[${agent.memoryVariables.join(', ')}]` : '';
    const modelPolicy = agent.modelPolicy
      ? ` modelPolicy=${JSON.stringify(agent.modelPolicy)}`
      : '';
    lines.push(`- ${agent.name}: ${agent.role}${tools}${memory}${modelPolicy}`);
  }
  if (contract.sharedMemoryVariables.length > 0) {
    lines.push(`Shared/session variables: ${contract.sharedMemoryVariables.join(', ')}`);
  }
  if ((contract.behaviorProfiles ?? []).length > 0) {
    lines.push(
      `Source behavior profiles available as standalone documents: ${(
        contract.behaviorProfiles ?? []
      )
        .map((profile) => profile.name)
        .join(', ')}.`,
    );
    lines.push('If an agent references one with USE BEHAVIOR_PROFILE, keep the exact name.');
  }
  if (
    contract.tools.some(
      (tool) => (tool.callWhen?.length ?? 0) > 0 || (tool.doNotCallWhen?.length ?? 0) > 0,
    )
  ) {
    lines.push('Tool call guidance:');
    for (const tool of contract.tools.slice(0, 20)) {
      const parts = [
        tool.callWhen?.length ? `call_when=[${tool.callWhen.join('; ')}]` : '',
        tool.doNotCallWhen?.length ? `do_not_call_when=[${tool.doNotCallWhen.join('; ')}]` : '',
      ].filter(Boolean);
      if (parts.length > 0) lines.push(`- ${tool.name}: ${parts.join(' ')}`);
    }
  }
  if (contract.universalRules.length > 0) {
    lines.push('Universal rules:');
    for (const rule of contract.universalRules.slice(0, 8)) lines.push(`- ${rule}`);
  }
  if (contract.optionalExternalAgents.length > 0) {
    lines.push(
      `Optional external agents: ${contract.optionalExternalAgents.join(', ')}. Represent as external/open items unless the user asks to generate them locally.`,
    );
  }
  if ((contract.consentPolicies ?? []).length > 0) {
    lines.push('Consent policies:');
    for (const policy of (contract.consentPolicies ?? []).slice(0, 10)) {
      lines.push(
        `- ${policy.toolName ?? policy.action}: mode=${policy.mode}, requiredIn=${policy.requiredIn}, scope=[${policy.scopeFields.join(', ')}], fallback=${policy.fallback}`,
      );
    }
  }
  if ((contract.scenarioFixtures ?? []).length > 0) {
    lines.push('Scenario fixtures:');
    for (const fixture of (contract.scenarioFixtures ?? []).slice(0, 6)) {
      lines.push(
        `- ${fixture.name}${fixture.channel ? ` (${fixture.channel})` : ''}: user=${JSON.stringify(fixture.userMessage)}${fixture.expectedOutcome ? ` expected=${JSON.stringify(fixture.expectedOutcome)}` : ''}`,
      );
    }
  }
  lines.push(
    'Validation rule: generate_topology must include every declared local agent with exact names, declared tools, source entry point, and reachable supervisor routes.',
  );
  return lines.join('\n');
}

export type { SessionFileRecord };
