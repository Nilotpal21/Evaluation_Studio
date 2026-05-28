import type { JiraAssignedIssue } from './jira-client.js';

const DEFAULT_SIMPLE_LIMIT = 5;
const CLOSED_STATUS_NAMES = new Set([
  'done',
  'closed',
  'resolved',
  'cancelled',
  'canceled',
  "won't do",
  'wont do',
  'completed',
]);

export type JiraIssueStateBucket = 'open' | 'resolved';
export type JiraIssueComplexity = 'simple' | 'medium' | 'complex';
export type JiraIssueWorkflowAction =
  | 'ignore-resolved'
  | 'autonomous-candidate'
  | 'needs-human-triage'
  | 'needs-clarification';

export interface JiraAssigneeWorkflowOptions {
  defaultScope?: string[];
  simpleLimit?: number;
  modelDecisions?: readonly JiraIssueModelDecision[];
}

export interface JiraIssueModelDecision {
  key: string;
  complexity: JiraIssueComplexity;
  action: Exclude<JiraIssueWorkflowAction, 'ignore-resolved'>;
  confidence: 'low' | 'medium' | 'high';
  inferredScope?: string[];
  questions?: string[];
  reasoning: string;
}

export interface JiraIssueTriage {
  issue: JiraAssignedIssue;
  state: JiraIssueStateBucket;
  complexity: JiraIssueComplexity;
  action: JiraIssueWorkflowAction;
  score: number;
  reasons: string[];
  inferredScope: string[];
  questions: string[];
}

export interface JiraAssigneeWorkflowPlan {
  total: number;
  open: JiraIssueTriage[];
  resolved: JiraIssueTriage[];
  simple: JiraIssueTriage[];
  medium: JiraIssueTriage[];
  complex: JiraIssueTriage[];
  runnableSimple: JiraIssueTriage[];
  blockedSimple: JiraIssueTriage[];
}

export function buildJiraAssigneeWorkflowPlan(
  issues: readonly JiraAssignedIssue[],
  options: JiraAssigneeWorkflowOptions = {},
): JiraAssigneeWorkflowPlan {
  const decisionsByKey = new Map(
    (options.modelDecisions ?? []).map((decision) => [decision.key, decision]),
  );
  const triaged = issues.map((issue) =>
    triageJiraIssue(issue, options, decisionsByKey.get(issue.key)),
  );
  const open = triaged.filter((entry) => entry.state === 'open');
  const resolved = triaged.filter((entry) => entry.state === 'resolved');
  const simple = open.filter((entry) => entry.complexity === 'simple');
  const medium = open.filter((entry) => entry.complexity === 'medium');
  const complex = open.filter((entry) => entry.complexity === 'complex');
  const runnableSimple = simple
    .filter((entry) => entry.action === 'autonomous-candidate' && entry.inferredScope.length > 0)
    .slice(0, options.simpleLimit ?? DEFAULT_SIMPLE_LIMIT);
  const runnableSimpleKeys = new Set(runnableSimple.map((entry) => entry.issue.key));

  return {
    total: triaged.length,
    open,
    resolved,
    simple,
    medium,
    complex,
    runnableSimple,
    blockedSimple: simple.filter((entry) => !runnableSimpleKeys.has(entry.issue.key)),
  };
}

export function triageJiraIssue(
  issue: JiraAssignedIssue,
  options: JiraAssigneeWorkflowOptions = {},
  modelDecision?: JiraIssueModelDecision,
): JiraIssueTriage {
  const state = isResolvedIssue(issue) ? 'resolved' : 'open';
  if (state === 'resolved') {
    return {
      issue,
      state,
      complexity: 'simple',
      action: 'ignore-resolved',
      score: 0,
      reasons: ['JIRA status is resolved/closed'],
      inferredScope: [],
      questions: [],
    };
  }

  if (modelDecision) {
    const inferredScope =
      modelDecision.inferredScope && modelDecision.inferredScope.length > 0
        ? modelDecision.inferredScope
        : inferIssueScope(issue, options.defaultScope);
    const questions = [...(modelDecision.questions ?? [])];
    if (modelDecision.action === 'autonomous-candidate' && inferredScope.length === 0) {
      questions.push(
        `Model approved ${issue.key} for autonomous execution, but no implementation scope was available.`,
      );
    }
    return {
      issue,
      state,
      complexity: modelDecision.complexity,
      action: modelDecision.action,
      score:
        modelDecision.confidence === 'high' ? 3 : modelDecision.confidence === 'medium' ? 2 : 1,
      reasons: [`model confidence: ${modelDecision.confidence}`, modelDecision.reasoning],
      inferredScope,
      questions,
    };
  }

  const inferredScope = inferIssueScope(issue, options.defaultScope);
  const questions = [
    `Model triage is required before deciding whether ${issue.key} is simple, medium, or complex.`,
  ];
  if (inferredScope.length === 0) {
    questions.push(`Which package/app should ${issue.key} be scoped to?`);
  }
  return {
    issue,
    state,
    complexity: 'medium',
    action: 'needs-human-triage',
    score: 0,
    reasons: ['awaiting required model triage; no local complexity decision applied'],
    inferredScope,
    questions,
  };
}

export interface JiraIssueModelTriagePayload {
  issues: JiraIssueModelPromptRecord[];
}

export interface JiraIssueModelPromptRecord {
  key: string;
  summary: string;
  status: string;
  issueType?: string;
  priority?: string;
  labels: string[];
  components: string[];
  descriptionText?: string;
}

export function buildJiraIssueModelTriagePayload(
  issues: readonly JiraAssignedIssue[],
): JiraIssueModelTriagePayload {
  return {
    issues: issues
      .filter((issue) => !isResolvedIssue(issue))
      .map((issue) => ({
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        issueType: issue.issueType,
        priority: issue.priority,
        labels: issue.labels ?? [],
        components: issue.components ?? [],
        descriptionText: truncateForPrompt(issue.descriptionText ?? '', 1400),
      })),
  };
}

export function buildJiraIssueModelTriagePrompt(payload: JiraIssueModelTriagePayload): string {
  return [
    'You are triaging JIRA issues for HELIX implementation.',
    'Quality is more important than minimizing model cost.',
    'Classify each issue based only on the compact JIRA data provided.',
    'Do not guess missing requirements. If scope, repro, acceptance criteria, rollout, or risk is unclear, choose needs-clarification and include focused questions.',
    'Use simple only for narrow, low-risk issues with clear scope and expected/actual/proof.',
    'For autonomous-candidate, inferredScope must include at least one concrete app/package path.',
    'Use complex for security, auth, tenant isolation, migrations, broad refactors, data integrity, unclear rollout, or multi-package coordination.',
    'Return ONLY JSON with this shape:',
    '{"decisions":[{"key":"ABLP-123","complexity":"simple|medium|complex","action":"autonomous-candidate|needs-human-triage|needs-clarification","confidence":"low|medium|high","inferredScope":["apps/runtime"],"questions":["..."],"reasoning":"short rationale"}]}',
    '',
    JSON.stringify(payload),
  ].join('\n');
}

export function parseJiraIssueModelDecisions(output: string): JiraIssueModelDecision[] {
  const parsed = JSON.parse(extractJsonObject(output)) as { decisions?: unknown };
  if (!Array.isArray(parsed.decisions)) {
    throw new Error('JIRA model triage output missing decisions array');
  }

  return parsed.decisions.map((value) => normalizeModelDecision(value));
}

export function renderJiraAssigneeWorkflowReport(plan: JiraAssigneeWorkflowPlan): string {
  const lines: string[] = [
    'JIRA assignee workflow plan',
    `Total issues: ${plan.total}`,
    `Open: ${plan.open.length}`,
    `Resolved/closed: ${plan.resolved.length}`,
    `Open simple: ${plan.simple.length}`,
    `Open medium: ${plan.medium.length}`,
    `Open complex: ${plan.complex.length}`,
    `Runnable simple candidates: ${plan.runnableSimple.length}`,
  ];

  appendIssueGroup(lines, 'Simple candidates', plan.simple);
  appendIssueGroup(lines, 'Medium issues', plan.medium);
  appendIssueGroup(lines, 'Complex issues / questions needed', plan.complex);
  appendIssueGroup(lines, 'Resolved / no action', plan.resolved);

  return lines.join('\n');
}

export function buildSimpleIssueHelixCommand(issue: JiraIssueTriage): string {
  const quotedTitle = shellQuote(`[${issue.issue.key}] ${issue.issue.summary}`);
  const scope =
    issue.inferredScope.length > 0 ? ` --scope ${shellQuote(issue.inferredScope.join(','))}` : '';
  return [
    `helix fix ${quotedTitle}`,
    `--jira ${shellQuote(issue.issue.key)}`,
    scope.trim(),
    '--budget 75',
    '--autonomy thresholded',
    '--auto-commit-risk low',
    '--auto-commit-confidence 9',
  ]
    .filter(Boolean)
    .join(' ');
}

function isResolvedIssue(issue: JiraAssignedIssue): boolean {
  const statusCategoryKey = issue.statusCategoryKey?.trim().toLowerCase();
  if (statusCategoryKey === 'done') {
    return true;
  }
  return CLOSED_STATUS_NAMES.has(issue.status.trim().toLowerCase());
}

function inferIssueScope(issue: JiraAssignedIssue, defaultScope?: string[]): string[] {
  if (defaultScope && defaultScope.length > 0) {
    return defaultScope;
  }

  const candidates = [...(issue.components ?? []), ...(issue.labels ?? [])]
    .map(normalizeScopeCandidate)
    .filter((entry): entry is string => entry != null);
  return [...new Set(candidates)].slice(0, 3);
}

function normalizeScopeCandidate(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('apps/') || normalized.startsWith('packages/')) {
    return normalized;
  }
  if (normalized.includes('runtime')) {
    return 'apps/runtime';
  }
  if (normalized.includes('studio')) {
    return 'apps/studio';
  }
  if (normalized.includes('helix')) {
    return 'packages/helix';
  }
  if (normalized.includes('compiler')) {
    return 'packages/compiler';
  }
  if (normalized.includes('database')) {
    return 'packages/database';
  }
  return undefined;
}

function appendIssueGroup(lines: string[], title: string, issues: JiraIssueTriage[]): void {
  if (issues.length === 0) {
    return;
  }
  lines.push('', `${title}:`);
  for (const entry of issues) {
    const scope = entry.inferredScope.length > 0 ? ` scope=${entry.inferredScope.join(',')}` : '';
    lines.push(
      `- ${entry.issue.key} [${entry.issue.status}] ${entry.issue.summary} (${entry.complexity}, score=${entry.score}, action=${entry.action}${scope})`,
    );
    if (entry.questions.length > 0) {
      lines.push(`  questions: ${entry.questions.join(' | ')}`);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function truncateForPrompt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 16).trimEnd()} ...[truncated]`;
}

function extractJsonObject(output: string): string {
  const trimmed = output.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('JIRA model triage output did not contain a JSON object');
  }
  return trimmed.slice(start, end + 1);
}

function normalizeModelDecision(value: unknown): JiraIssueModelDecision {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid JIRA model decision entry');
  }
  const record = value as Record<string, unknown>;
  const key = readNonEmptyString(record['key'], 'key');
  const complexity = readEnum(record['complexity'], ['simple', 'medium', 'complex'], 'complexity');
  const action = readEnum(
    record['action'],
    ['autonomous-candidate', 'needs-human-triage', 'needs-clarification'],
    'action',
  );
  const confidence = readEnum(record['confidence'], ['low', 'medium', 'high'], 'confidence');
  const reasoning = readNonEmptyString(record['reasoning'], 'reasoning');
  const inferredScope = readStringArray(record['inferredScope']);
  const questions = readStringArray(record['questions']);
  return { key, complexity, action, confidence, inferredScope, questions, reasoning };
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid JIRA model decision ${field}`);
  }
  return value.trim();
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    throw new Error(`Invalid JIRA model decision ${field}`);
  }
  return value as T[number];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
