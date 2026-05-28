/**
 * HELIX — JIRA Integration Client
 *
 * Reads credentials from environment variables (never sources .env files).
 * Uses global fetch (Node 18+). JIRA failures never crash the pipeline —
 * all functions return graceful fallbacks or re-throw wrapped errors.
 */

import type { Finding, Session, Slice, StageResult } from '../types.js';

// ─── Logging ─────────────────────────────────────────────────────

const PREFIX = '[helix:jira]';

function logInfo(msg: string): void {
  process.stderr.write(`${PREFIX} ${msg}\n`);
}

function logError(msg: string): void {
  process.stderr.write(`${PREFIX} ERROR: ${msg}\n`);
}

// ─── Types ───────────────────────────────────────────────────────

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  description: string | null;
  labels?: string[];
}

export interface JiraAssignedIssue extends JiraIssue {
  statusCategoryKey?: string;
  issueType?: string;
  priority?: string;
  components?: string[];
  updated?: string;
  created?: string;
  resolutionDate?: string | null;
  descriptionText?: string;
}

export interface SearchAssignedIssuesOptions {
  assignee?: string;
  projectKey?: string;
  maxResults?: number;
  includeDone?: boolean;
}

export interface CreateTicketParams {
  projectKey: string;
  summary: string;
  description: AdfDocument;
  issueType?: string;
  labels?: string[];
}

export interface UpdateTicketParams {
  description?: AdfDocument;
  comment?: AdfDocument;
  labels?: string[];
}

export interface DescriptionSection {
  heading: string;
  content: string;
}

/** Atlassian Document Format (ADF) — top-level document node */
export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

/** Generic ADF node shape */
interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

// ─── Credential Resolution ───────────────────────────────────────

interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

function resolveCredentials(): JiraCredentials | null {
  const baseUrl = process.env['JIRA_BASE_URL'] || process.env['ATLASSIAN_BASE_URL'];
  const email = process.env['JIRA_EMAIL'];
  const apiToken = process.env['ATLASSIAN_API_KEY'] || process.env['JIRA_API_TOKEN'];

  if (!baseUrl || !email || !apiToken) {
    logInfo('JIRA credentials not configured — set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN');
    return null;
  }

  // Strip trailing slash from base URL
  return { baseUrl: baseUrl.replace(/\/+$/, ''), email, apiToken };
}

// ─── HTTP Helper ─────────────────────────────────────────────────

async function jiraFetch(
  creds: JiraCredentials,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${creds.baseUrl}/${path}`;
  const authHeader = `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')}`;

  const headers: Record<string, string> = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  return fetch(url, {
    ...options,
    headers,
  });
}

// ─── ADF Helpers ─────────────────────────────────────────────────

/**
 * Build an ADF document from structured sections.
 * Each section becomes a heading + paragraph block.
 */
export function buildAdfDescription(sections: DescriptionSection[]): AdfDocument {
  const content: AdfNode[] = [];

  for (const section of sections) {
    // Heading node
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: section.heading }],
    });

    // Paragraph node — split on newlines to preserve formatting
    const lines = section.content.split('\n');
    const paragraphContent: AdfNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        paragraphContent.push({ type: 'hardBreak' });
      }
      paragraphContent.push({ type: 'text', text: lines[i] });
    }

    content.push({
      type: 'paragraph',
      content: paragraphContent,
    });
  }

  return { version: 1, type: 'doc', content };
}

// ─── Core Operations ─────────────────────────────────────────────

/**
 * Search for existing JIRA tickets matching a query string.
 * Uses POST to `rest/api/3/search/jql` (v3 endpoint).
 * Returns up to 5 matches ordered by most recently updated.
 */
export async function searchRelevantTickets(
  query: string,
  projectKey?: string,
): Promise<JiraIssue[]> {
  const creds = resolveCredentials();
  if (!creds) return [];

  try {
    // Escape double quotes in query for JQL text match
    const escapedQuery = query.replace(/"/g, '\\"');
    let jql = `text ~ "${escapedQuery}" ORDER BY updated DESC`;
    if (projectKey) {
      jql = `project = "${projectKey}" AND text ~ "${escapedQuery}" ORDER BY updated DESC`;
    }

    const response = await jiraFetch(creds, 'rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: 5,
        fields: ['summary', 'status', 'description'],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logError(`search failed (${response.status}): ${body}`);
      return [];
    }

    const data = (await response.json()) as {
      issues?: Array<{
        key: string;
        fields: {
          summary: string;
          status: { name: string };
          description: unknown;
        };
      }>;
    };

    return (data.issues ?? []).map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      description: issue.fields.description ? JSON.stringify(issue.fields.description) : null,
    }));
  } catch (err: unknown) {
    logError(`search error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Search JIRA for issues that carry a specific label. Used by the drift-sync
 * adapter to find prior drift tickets by their deterministic `helix-drift-*`
 * label (JQL `labels = "…"` is exact-match, not a text search, so this is
 * reliable for idempotent rerun detection).
 */
export async function searchByLabel(label: string, projectKey?: string): Promise<JiraIssue[]> {
  const creds = resolveCredentials();
  if (!creds) return [];

  try {
    const escapedLabel = label.replace(/"/g, '\\"');
    let jql = `labels = "${escapedLabel}" ORDER BY updated DESC`;
    if (projectKey) {
      jql = `project = "${projectKey}" AND labels = "${escapedLabel}" ORDER BY updated DESC`;
    }

    const response = await jiraFetch(creds, 'rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: 10,
        fields: ['summary', 'status', 'labels'],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logError(`searchByLabel failed (${response.status}): ${body}`);
      return [];
    }

    const data = (await response.json()) as {
      issues?: Array<{
        key: string;
        fields: {
          summary: string;
          status: { name: string };
          labels?: string[];
        };
      }>;
    };

    return (data.issues ?? []).map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      description: null,
      labels: issue.fields.labels ?? [],
    }));
  } catch (err: unknown) {
    logError(`searchByLabel error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Search JIRA issues assigned to a user. Defaults to `currentUser()` so a
 * caller can fetch "my issues" without spending a model turn discovering the
 * JIRA account id first.
 */
export async function searchAssignedIssues(
  options: SearchAssignedIssuesOptions = {},
): Promise<JiraAssignedIssue[]> {
  const creds = resolveCredentials();
  if (!creds) return [];

  try {
    const assignee = options.assignee?.trim() || 'currentUser()';
    const clauses = [buildAssigneeClause(assignee)];
    if (options.projectKey) {
      clauses.unshift(`project = "${escapeJqlString(options.projectKey)}"`);
    }
    if (options.includeDone === false) {
      clauses.push('statusCategory != Done');
    }

    const response = await jiraFetch(creds, 'rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql: `${clauses.join(' AND ')} ORDER BY updated DESC`,
        maxResults: options.maxResults ?? 50,
        fields: [
          'summary',
          'status',
          'description',
          'labels',
          'issuetype',
          'priority',
          'components',
          'updated',
          'created',
          'resolutiondate',
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logError(`searchAssignedIssues failed (${response.status}): ${body}`);
      return [];
    }

    const data = (await response.json()) as {
      issues?: Array<{
        key: string;
        fields: {
          summary: string;
          status: {
            name: string;
            statusCategory?: { key?: string; name?: string };
          };
          description: unknown;
          labels?: string[];
          issuetype?: { name?: string };
          priority?: { name?: string };
          components?: Array<{ name?: string }>;
          updated?: string;
          created?: string;
          resolutiondate?: string | null;
        };
      }>;
    };

    return (data.issues ?? []).map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      statusCategoryKey: issue.fields.status.statusCategory?.key,
      description: issue.fields.description ? JSON.stringify(issue.fields.description) : null,
      descriptionText: adfToPlainText(issue.fields.description),
      labels: issue.fields.labels ?? [],
      issueType: issue.fields.issuetype?.name,
      priority: issue.fields.priority?.name,
      components: (issue.fields.components ?? [])
        .map((component) => component.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
      updated: issue.fields.updated,
      created: issue.fields.created,
      resolutionDate: issue.fields.resolutiondate ?? null,
    }));
  } catch (err: unknown) {
    logError(`searchAssignedIssues error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Single-method test port for Jira issue fetch. Production callers use the
 * default singleton (`defaultJiraIssueClient`) via `getIssue(key)`. Tests
 * inject an in-memory implementation by passing a custom client to
 * `getIssue(key, client)`.
 *
 * Intentionally narrower than `DriftJiraClient` (drift-jira-adapter.ts:167);
 * the bootstrap path only needs `getIssue`. A future cleanup could collapse
 * the two interfaces.
 */
export interface JiraIssueClient {
  getIssue(key: string): Promise<JiraAssignedIssue | null>;
}

/**
 * Map a single Jira REST `/issue/{key}` response into a `JiraAssignedIssue`.
 * Mirrors the projection used by `searchAssignedIssues` so consumers get a
 * single canonical shape regardless of which fetch path produced the issue.
 */
function projectIssueResponse(issue: {
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory?: { key?: string; name?: string } };
    description: unknown;
    labels?: string[];
    issuetype?: { name?: string };
    priority?: { name?: string };
    components?: Array<{ name?: string }>;
    updated?: string;
    created?: string;
    resolutiondate?: string | null;
  };
}): JiraAssignedIssue {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    statusCategoryKey: issue.fields.status.statusCategory?.key,
    description: issue.fields.description ? JSON.stringify(issue.fields.description) : null,
    descriptionText: adfToPlainText(issue.fields.description),
    labels: issue.fields.labels ?? [],
    issueType: issue.fields.issuetype?.name,
    priority: issue.fields.priority?.name,
    components: (issue.fields.components ?? [])
      .map((component) => component.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
    updated: issue.fields.updated,
    created: issue.fields.created,
    resolutionDate: issue.fields.resolutiondate ?? null,
  };
}

/**
 * Fetch a single Jira issue by key via `GET /rest/api/3/issue/{key}`. Returns
 * the `JiraAssignedIssue` projection on success or `null` on any failure
 * (missing creds, 401/403, 404, network error). NEVER throws — matches the
 * "JIRA failures never crash the pipeline" contract from this file's header.
 *
 * The optional `client` parameter is for tests; production callers use the
 * default singleton which performs the real HTTP fetch.
 */
export async function getIssue(
  key: string,
  client?: JiraIssueClient,
): Promise<JiraAssignedIssue | null> {
  if (client) {
    return client.getIssue(key);
  }
  return defaultJiraIssueClient.getIssue(key);
}

const defaultJiraIssueClient: JiraIssueClient = {
  async getIssue(key: string): Promise<JiraAssignedIssue | null> {
    const creds = resolveCredentials();
    if (!creds) return null;

    try {
      const response = await jiraFetch(creds, `rest/api/3/issue/${encodeURIComponent(key)}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logError(`getIssue ${key} failed (${response.status}): ${body}`);
        return null;
      }

      const data = (await response.json()) as {
        key: string;
        fields: {
          summary: string;
          status: { name: string; statusCategory?: { key?: string; name?: string } };
          description: unknown;
          labels?: string[];
          issuetype?: { name?: string };
          priority?: { name?: string };
          components?: Array<{ name?: string }>;
          updated?: string;
          created?: string;
          resolutiondate?: string | null;
        };
      };

      return projectIssueResponse(data);
    } catch (err: unknown) {
      logError(`getIssue ${key} error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  },
};

function buildAssigneeClause(assignee: string): string {
  if (assignee === 'currentUser()') {
    return 'assignee = currentUser()';
  }
  return `assignee = "${escapeJqlString(assignee)}"`;
}

function escapeJqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function adfToPlainText(value: unknown): string {
  const parts: string[] = [];
  collectAdfText(value, parts);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function collectAdfText(value: unknown, parts: string[]): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as { text?: unknown; content?: unknown };
  if (typeof record.text === 'string') {
    parts.push(record.text);
  }
  if (Array.isArray(record.content)) {
    for (const child of record.content) {
      collectAdfText(child, parts);
    }
  }
}

/**
 * Create a new JIRA ticket.
 * Default issue type is "Task".
 */
export async function createTicket(params: CreateTicketParams): Promise<JiraIssue> {
  const creds = resolveCredentials();
  if (!creds) {
    throw new Error('JIRA credentials not configured');
  }

  try {
    const fields: Record<string, unknown> = {
      project: { key: params.projectKey },
      summary: params.summary,
      description: params.description,
      issuetype: { name: params.issueType ?? 'Story' },
    };

    if (params.labels && params.labels.length > 0) {
      fields['labels'] = params.labels;
    }

    const response = await jiraFetch(creds, 'rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`create ticket failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { key: string };

    logInfo(`created ticket ${data.key}`);

    return {
      key: data.key,
      summary: params.summary,
      status: 'To Do',
      description: JSON.stringify(params.description),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`create ticket error: ${message}`);
    throw new Error(`JIRA create ticket failed: ${message}`);
  }
}

/**
 * Update an existing JIRA ticket.
 * Supports updating description, adding a comment, and setting labels.
 */
export async function updateTicket(key: string, params: UpdateTicketParams): Promise<void> {
  const creds = resolveCredentials();
  if (!creds) {
    throw new Error('JIRA credentials not configured');
  }

  try {
    // Update fields (description, labels)
    if (params.description !== undefined || params.labels !== undefined) {
      const fields: Record<string, unknown> = {};
      if (params.description !== undefined) {
        fields['description'] = params.description;
      }
      if (params.labels !== undefined) {
        fields['labels'] = params.labels;
      }

      const response = await jiraFetch(creds, `rest/api/3/issue/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`update ticket ${key} failed (${response.status}): ${body}`);
      }

      logInfo(`updated ticket ${key}`);
    }

    // Add comment
    if (params.comment !== undefined) {
      const response = await jiraFetch(creds, `rest/api/3/issue/${key}/comment`, {
        method: 'POST',
        body: JSON.stringify({ body: params.comment }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`add comment to ${key} failed (${response.status}): ${body}`);
      }

      logInfo(`added comment to ${key}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`update ticket error: ${message}`);
    throw new Error(`JIRA update ticket failed: ${message}`);
  }
}

// ─── Session Enrichment ──────────────────────────────────────────

/**
 * Build a rich ADF comment from a HELIX session.
 * Extracts findings, scope, impacted files, decisions, stage outputs.
 */
function buildSessionEnrichmentComment(session: Session): AdfDocument {
  const sections: DescriptionSection[] = [];

  // Summary
  sections.push({
    heading: 'Summary',
    content: `${session.workItem.title}\n${session.workItem.description}`,
  });

  // Findings
  if (session.findings.length > 0) {
    const findingLines = session.findings.map(
      (f: Finding) =>
        `[${f.severity.toUpperCase()}] ${f.title} — ${f.files.map((fr) => fr.path).join(', ')}`,
    );
    sections.push({
      heading: 'Findings',
      content: findingLines.join('\n'),
    });
  }

  // Impact Areas (from slice file contracts)
  const impactedFiles = collectImpactedFiles(session.slices);
  if (impactedFiles.length > 0) {
    sections.push({
      heading: 'Impact Areas',
      content: impactedFiles.join('\n'),
    });
  }

  // Steps to Reproduce (from reproduce stage output)
  const reproduceOutput = findStageOutput(session.stageHistory, 'reproduce');
  if (reproduceOutput) {
    sections.push({
      heading: 'Steps to Reproduce',
      content: reproduceOutput,
    });
  }

  // Test Coverage (from testing stage output)
  const testingOutput = findStageOutput(session.stageHistory, 'testing');
  if (testingOutput) {
    sections.push({
      heading: 'Test Coverage',
      content: testingOutput,
    });
  }

  // Validation Criteria (from quality gate results)
  const qualityGateResults = session.stageHistory
    .filter((sr) => sr.stageType === 'review' || sr.stageType === 'regression')
    .map(
      (sr) =>
        `${sr.stageName}: ${sr.status} (${sr.iterations} iteration${sr.iterations !== 1 ? 's' : ''})`,
    );
  if (qualityGateResults.length > 0) {
    sections.push({
      heading: 'Validation Criteria',
      content: qualityGateResults.join('\n'),
    });
  }

  // Decisions
  if (session.decisions.length > 0) {
    const decisionLines = session.decisions.map(
      (d) => `[${d.classification}] ${d.question}${d.answer ? ` → ${d.answer}` : ''}`,
    );
    sections.push({
      heading: 'Decisions',
      content: decisionLines.join('\n'),
    });
  }

  return buildAdfDescription(sections);
}

/** Maximum number of impacted files to collect (prevents unbounded growth) */
const MAX_IMPACTED_FILES = 500;

/**
 * Collect impacted files from slice file contracts.
 * Bounded to MAX_IMPACTED_FILES to prevent unbounded collection growth.
 */
function collectImpactedFiles(slices: Slice[]): string[] {
  const files: string[] = [];
  const seen = new Map<string, true>();

  for (const slice of slices) {
    for (const fc of slice.manifest.fileContracts) {
      const entry = `${fc.path} (${fc.action}: ${fc.reason})`;
      if (!seen.has(entry) && files.length < MAX_IMPACTED_FILES) {
        seen.set(entry, true);
        files.push(entry);
      }
    }
    for (const dep of slice.impactAnalysis.dependentFiles) {
      if (!seen.has(dep) && files.length < MAX_IMPACTED_FILES) {
        seen.set(dep, true);
        files.push(dep);
      }
    }
    // Evict old entries if we hit the cap — stop collecting
    if (files.length >= MAX_IMPACTED_FILES) break;
  }

  return files;
}

/**
 * Find stage output text by stage type.
 */
function findStageOutput(stageHistory: StageResult[], stageType: string): string | null {
  const result = stageHistory.find((sr) => sr.stageType === stageType);
  return result?.output ?? null;
}

/**
 * Enrich a JIRA ticket with information from a HELIX session.
 * Adds a comprehensive comment covering findings, scope, impact, and decisions.
 */
export async function enrichTicketFromSession(key: string, session: Session): Promise<void> {
  const comment = buildSessionEnrichmentComment(session);
  await updateTicket(key, { comment });
  logInfo(`enriched ticket ${key} from session ${session.id}`);
}

/**
 * Post the final scenario-evidence mapping required for HELIX Jira completion.
 * This intentionally happens after scenario evidence gates, not at each slice
 * commit, so every Jira completion comment can name exact artifacts.
 */
export async function postScenarioEvidenceComment(key: string, session: Session): Promise<void> {
  const comment = buildScenarioEvidenceComment(session);
  await updateTicket(key, { comment });
  logInfo(`posted scenario evidence comment to ${key} from session ${session.id}`);
}

function buildScenarioEvidenceComment(session: Session): AdfDocument {
  const jiraKey = session.workItem.jiraKey ?? 'UNKNOWN';
  const rootCause =
    findStageOutput(session.stageHistory, 'root-cause') ?? summarizeFindings(session);
  const fixCommits =
    session.commits.length > 0
      ? session.commits.map((commit) => `${commit.sha} ${commit.message}`).join('\n')
      : '(no commits recorded)';
  const evidenceArtifacts = collectScenarioEvidenceLines(session).join('\n') || '(none recorded)';
  const verificationCommands =
    collectVerificationCommands(session).join('\n') || '(no verification commands recorded)';
  const residualRisk = collectResidualRisk(session);

  return buildAdfDescription([
    {
      heading: 'Jira Scenario',
      content: [`${jiraKey}: ${session.workItem.title}`, session.workItem.description]
        .filter(Boolean)
        .join('\n'),
    },
    {
      heading: 'Root Cause',
      content: truncateCommentSection(rootCause),
    },
    {
      heading: 'Fix Commit',
      content: fixCommits,
    },
    {
      heading: 'Exact Evidence Artifact',
      content: evidenceArtifacts,
    },
    {
      heading: 'Verification Command',
      content: verificationCommands,
    },
    {
      heading: 'Residual Risk',
      content: residualRisk,
    },
  ]);
}

function summarizeFindings(session: Session): string {
  if (session.findings.length === 0) {
    return 'No separate root-cause finding was recorded; see the Jira scenario and implementation commits.';
  }
  return session.findings
    .slice(0, 10)
    .map((finding) => `[${finding.severity}] ${finding.title}: ${finding.description}`)
    .join('\n');
}

function collectScenarioEvidenceLines(session: Session): string[] {
  const lines: string[] = [];
  for (const stage of session.stageHistory) {
    const scenarioCheck = stage.qualityGate?.checks.find(
      (check) => check.name === 'Scenario-mapped Jira evidence exists',
    );
    if (!scenarioCheck?.output) continue;
    lines.push(`${stage.stageName}: ${scenarioCheck.output}`);
  }
  return lines;
}

function collectVerificationCommands(session: Session): string[] {
  const commands: string[] = [];
  for (const stage of session.stageHistory) {
    for (const check of stage.qualityGate?.checks ?? []) {
      if (check.command) {
        commands.push(`${stage.stageName} / ${check.name}: ${check.command}`);
      }
    }
  }
  return commands.slice(0, 25);
}

function collectResidualRisk(session: Session): string {
  const failedChecks = session.stageHistory.flatMap((stage) =>
    (stage.qualityGate?.checks ?? [])
      .filter((check) => !check.passed)
      .map((check) => `${stage.stageName} / ${check.name}: ${check.output ?? 'failed'}`),
  );
  if (failedChecks.length === 0 && session.state === 'completed') {
    return 'No blocking residual risk recorded by completed HELIX gates.';
  }
  if (failedChecks.length === 0) {
    return `Session ended in state ${session.state}; review HELIX session ${session.id} before closing the ticket.`;
  }
  return failedChecks.slice(0, 10).join('\n');
}

function truncateCommentSection(value: string, maxLength = 5_000): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 32).trimEnd()}\n...[truncated by HELIX]`;
}

// ─── Find or Create ──────────────────────────────────────────────

/** Status values that indicate an open/active ticket */
const OPEN_STATUSES = [
  'to do',
  'open',
  'in progress',
  'in review',
  'backlog',
  'selected for development',
];

/**
 * Find an existing open ticket matching the work item, or create a new one.
 * Returns the JIRA ticket key (e.g. "ABLP-123").
 *
 * If JIRA credentials are not configured, returns an empty string
 * (the pipeline continues without JIRA integration).
 */
export async function findOrCreateTicket(session: Session, projectKey?: string): Promise<string> {
  const creds = resolveCredentials();
  if (!creds) {
    return '';
  }

  const resolvedProject = projectKey ?? process.env['JIRA_PROJECT_KEY'] ?? 'ABLP';

  try {
    // Search for existing tickets matching the work item title
    const existing = await searchRelevantTickets(session.workItem.title, resolvedProject);

    // Find an open ticket we can reuse
    const openTicket = existing.find((t) => OPEN_STATUSES.includes(t.status.toLowerCase()));

    if (openTicket) {
      logInfo(`reusing existing ticket ${openTicket.key} (${openTicket.status})`);
      // Enrich with session data (best-effort — don't fail if comment is too large)
      try {
        await enrichTicketFromSession(openTicket.key, session);
      } catch (enrichErr) {
        logError(
          `enrichment failed for ${openTicket.key}: ${enrichErr instanceof Error ? enrichErr.message : String(enrichErr)}`,
        );
      }
      return openTicket.key;
    }

    // No suitable ticket found — create a new one
    const description = buildSessionEnrichmentComment(session);
    const ticket = await createTicket({
      projectKey: resolvedProject,
      summary: session.workItem.title,
      description,
      labels: ['helix', session.workItem.type],
    });

    return ticket.key;
  } catch (err: unknown) {
    logError(`findOrCreateTicket failed: ${err instanceof Error ? err.message : String(err)}`);
    // JIRA failures should never crash the pipeline
    return '';
  }
}
