#!/usr/bin/env npx tsx
/**
 * Jira REST API v3 Client
 *
 * Provides methods for managing fix versions, tickets, and transitions
 * in Jira. All operations are optional — if env vars are missing, methods
 * log a warning and return gracefully.
 *
 * Environment variables:
 *   JIRA_BASE_URL   — e.g. https://mycompany.atlassian.net
 *   ATLASSIAN_BASE_URL — alias for JIRA_BASE_URL
 *   JIRA_EMAIL      — Jira account email
 *   JIRA_API_TOKEN  — Jira API token (preferred variable name)
 *   ATLASSIAN_API_KEY — supported alias for Jira API token in local `.env`
 *
 * Usage:
 *   import { JiraClient } from './jira-client.js';
 *   const jira = new JiraClient();
 *   if (!jira.isConfigured()) { console.warn('Jira not configured, skipping'); }
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { loadJiraEnvFromDotEnv } from './jira-update-lib.js';

loadJiraEnvFromDotEnv();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

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

export interface DescriptionSection {
  heading: string;
  content: string;
}

interface JiraResult<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface JiraVersion {
  id: string;
  name: string;
  projectId?: number;
  released?: boolean;
  releaseDate?: string;
  self?: string;
}

interface JiraStatus {
  name: string;
  statusCategory?: { name: string };
}

interface JiraTicketFields {
  summary: string;
  status: JiraStatus;
  fixVersions: JiraVersion[];
}

interface JiraTicket {
  key: string;
  fields: JiraTicketFields;
}

interface JiraTransition {
  id: string;
  name: string;
  to?: JiraStatus;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  accountType?: string;
}

export interface JiraTransitionPathResult {
  status: string;
  appliedTransitions: string[];
}

export interface TicketSummary {
  key: string;
  summary: string;
  status: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  description: string | null;
}

export interface CreateTicketParams {
  projectKey: string;
  summary: string;
  description: AdfDocument;
  issueType?: string;
  labels?: string[];
  priority?: string;
  assigneeEmail?: string;
}

export interface UpdateTicketParams {
  description?: AdfDocument;
  comment?: AdfDocument;
  labels?: string[];
}

type SectionBlock =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'subheading'; text: string }
  | { type: 'bulletList'; items: string[] }
  | { type: 'orderedList'; items: string[] };

interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

const DEFAULT_TRANSITION_PATH = [
  'WIP',
  'In Progress',
  'In Review',
  'PR Review',
  'Review Completed',
  'Ready For QA',
  'Development Completed',
  'QA Pass',
  'Done',
];

function resolveCredentials(): JiraCredentials | null {
  const baseUrl = process.env.JIRA_BASE_URL || process.env.ATLASSIAN_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN || process.env.ATLASSIAN_API_KEY;

  if (!baseUrl || !email || !apiToken) {
    return null;
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ''), email, apiToken };
}

function normalizeJiraName(value: string): string {
  return value.trim().toLowerCase();
}

function formatTransition(transition: JiraTransition): string {
  return `${transition.name}${transition.to?.name ? ` -> ${transition.to.name}` : ''}`;
}

function findMatchingTransition(
  transitions: JiraTransition[],
  transitionOrStatusName: string,
): JiraTransition | undefined {
  const normalized = normalizeJiraName(transitionOrStatusName);
  return transitions.find(
    (transition) =>
      normalizeJiraName(transition.name) === normalized ||
      (transition.to?.name && normalizeJiraName(transition.to.name) === normalized),
  );
}

async function jiraFetch(
  creds: JiraCredentials,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  return fetch(`${creds.baseUrl}/${path}`, {
    ...options,
    headers,
  });
}

export function buildAdfDescription(sections: DescriptionSection[]): AdfDocument {
  const content: AdfNode[] = [];

  for (const section of sections) {
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: section.heading }],
    });

    content.push(...buildSectionContent(section.content));
  }

  return { version: 1, type: 'doc', content };
}

function buildSectionContent(rawContent: string): AdfNode[] {
  return parseSectionBlocks(rawContent).map((block) => {
    if (block.type === 'subheading') {
      return {
        type: 'heading',
        attrs: { level: 4 },
        content: buildInlineContent(block.text),
      };
    }

    if (block.type === 'paragraph') {
      return buildParagraphNode(block.lines);
    }

    const listType = block.type;
    return {
      type: listType,
      content: block.items.map((item) => ({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: buildInlineContent(item),
          },
        ],
      })),
    };
  });
}

function parseSectionBlocks(content: string): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  const lines = normalizeEscapedLineBreaks(content).split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (isSubheadingLine(line)) {
      blocks.push({ type: 'subheading', text: line.trim() });
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*]\s+/, '').trimEnd());
        index += 1;
      }
      blocks.push({ type: 'bulletList', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+\.\s+/, '').trimEnd());
        index += 1;
      }
      blocks.push({ type: 'orderedList', items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim().length > 0 &&
      !/^\s*[-*]\s+/.test(lines[index] ?? '') &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? '')
    ) {
      paragraphLines.push((lines[index] ?? '').trimEnd());
      index += 1;
    }
    blocks.push({ type: 'paragraph', lines: paragraphLines });
  }

  return blocks;
}

function normalizeEscapedLineBreaks(content: string): string {
  return content
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

function isSubheadingLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.endsWith(':') &&
    trimmed.length > 1 &&
    trimmed.length <= 80 &&
    !trimmed.includes('\t') &&
    !/^\s*[-*]\s+/.test(line) &&
    !/^\s*\d+\.\s+/.test(line)
  );
}

function buildParagraphNode(lines: string[]): AdfNode {
  const content: AdfNode[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) {
      content.push({ type: 'hardBreak' });
    }
    content.push(...buildInlineContent(lines[index] ?? ''));
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    type: 'paragraph',
    content,
  };
}

function buildInlineContent(text: string): AdfNode[] {
  if (text.length === 0) {
    return [{ type: 'text', text: '' }];
  }

  const content: AdfNode[] = [];
  const codePattern = /`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(text)) !== null) {
    const [matched, codeText] = match;
    const prefix = text.slice(lastIndex, match.index);
    if (prefix.length > 0) {
      content.push({ type: 'text', text: prefix });
    }

    content.push({
      type: 'text',
      text: codeText,
      marks: [{ type: 'code' }],
    });
    lastIndex = match.index + matched.length;
  }

  const suffix = text.slice(lastIndex);
  if (suffix.length > 0 || content.length === 0) {
    content.push({ type: 'text', text: suffix });
  }

  return content;
}

export async function createTicket(params: CreateTicketParams): Promise<JiraIssue> {
  const creds = resolveCredentials();
  if (!creds) {
    throw new Error('JIRA credentials not configured');
  }

  const fields: Record<string, unknown> = {
    project: { key: params.projectKey },
    summary: params.summary,
    description: params.description,
    issuetype: { name: params.issueType ?? 'Story' },
  };

  if (params.labels && params.labels.length > 0) {
    fields['labels'] = params.labels;
  }

  if (params.priority) {
    fields['priority'] = { name: params.priority };
  }

  if (params.assigneeEmail) {
    fields['assignee'] = { emailAddress: params.assigneeEmail };
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

  return {
    key: data.key,
    summary: params.summary,
    status: 'To Do',
    description: JSON.stringify(params.description),
  };
}

export async function updateTicket(key: string, params: UpdateTicketParams): Promise<void> {
  const creds = resolveCredentials();
  if (!creds) {
    throw new Error('JIRA credentials not configured');
  }

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
  }

  if (params.comment !== undefined) {
    const response = await jiraFetch(creds, `rest/api/3/issue/${key}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: params.comment }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`add comment to ${key} failed (${response.status}): ${body}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class JiraClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly token: string;
  private readonly configured: boolean;

  constructor() {
    const credentials = resolveCredentials();
    this.baseUrl = credentials?.baseUrl ?? '';
    this.email = credentials?.email ?? '';
    this.token = credentials?.apiToken ?? '';
    this.configured = credentials !== null;
  }

  /** Returns true when all required env vars are present. */
  isConfigured(): boolean {
    return this.configured;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.email}:${this.token}`).toString('base64')}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<JiraResult<T>> {
    if (!this.configured) {
      return {
        success: false,
        error: {
          code: 'NOT_CONFIGURED',
          message:
            'Jira env vars missing (JIRA_BASE_URL/ATLASSIAN_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/ATLASSIAN_API_KEY)',
        },
      };
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          success: false,
          error: {
            code: `HTTP_${res.status}`,
            message: `${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
          },
        };
      }

      // Some endpoints return 204 No Content
      if (res.status === 204) {
        return { success: true, data: undefined as unknown as T };
      }

      const data = (await res.json()) as T;
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: { code: 'FETCH_ERROR', message },
      };
    }
  }

  // ── Fix Versions ────────────────────────────────────────────────────────

  /** Create a fix version for the given project. */
  async createFixVersion(
    projectKey: string,
    name: string,
    releaseDate?: string,
  ): Promise<JiraResult<JiraVersion>> {
    const body: Record<string, unknown> = {
      name,
      project: projectKey,
    };
    if (releaseDate) {
      body.releaseDate = releaseDate;
    }
    return this.request<JiraVersion>('POST', '/rest/api/3/version', body);
  }

  /** Mark a fix version as released. */
  async releaseFixVersion(versionId: string): Promise<JiraResult<JiraVersion>> {
    return this.request<JiraVersion>('PUT', `/rest/api/3/version/${versionId}`, {
      released: true,
      releaseDate: new Date().toISOString().slice(0, 10),
    });
  }

  /** Look up a fix version by name within a project. */
  async getFixVersion(projectKey: string, name: string): Promise<JiraResult<JiraVersion | null>> {
    const result = await this.request<JiraVersion[]>(
      'GET',
      `/rest/api/3/project/${projectKey}/versions`,
    );
    if (!result.success) {
      return {
        success: false,
        error: result.error,
      };
    }
    const match = result.data?.find((v) => v.name === name) ?? null;
    return { success: true, data: match };
  }

  // ── Tickets ─────────────────────────────────────────────────────────────

  /** Fetch a single ticket with summary, status, and fixVersions. */
  async getTicket(ticketKey: string): Promise<JiraResult<JiraTicket>> {
    return this.request<JiraTicket>(
      'GET',
      `/rest/api/3/issue/${ticketKey}?fields=summary,status,fixVersions`,
    );
  }

  /** Set (replace) the fix version on a ticket. */
  async setFixVersion(ticketKey: string, versionId: string): Promise<JiraResult<void>> {
    return this.request<void>('PUT', `/rest/api/3/issue/${ticketKey}`, {
      fields: {
        fixVersions: [{ id: versionId }],
      },
    });
  }

  /** Fetch the current status name for a ticket. */
  async getTicketStatus(ticketKey: string): Promise<JiraResult<string>> {
    const result = await this.request<{ fields: { status: JiraStatus } }>(
      'GET',
      `/rest/api/3/issue/${ticketKey}?fields=status`,
    );
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? { code: 'NO_STATUS', message: `Could not fetch ${ticketKey}` },
      };
    }

    return { success: true, data: result.data.fields.status.name };
  }

  /** Fetch currently available transitions for a ticket. */
  async getTicketTransitions(ticketKey: string): Promise<JiraResult<JiraTransition[]>> {
    const transitions = await this.request<{ transitions: JiraTransition[] }>(
      'GET',
      `/rest/api/3/issue/${ticketKey}/transitions`,
    );
    if (!transitions.success || !transitions.data) {
      return {
        success: false,
        error: transitions.error ?? {
          code: 'NO_TRANSITIONS',
          message: `Could not fetch transitions for ${ticketKey}`,
        },
      };
    }

    return { success: true, data: transitions.data.transitions };
  }

  /** Transition a ticket by transition name or directly reachable destination status. */
  async transitionTicket(ticketKey: string, transitionName: string): Promise<JiraResult<void>> {
    const transitions = await this.getTicketTransitions(ticketKey);
    if (!transitions.success || !transitions.data) {
      return {
        success: false,
        error: transitions.error,
      };
    }

    const match = findMatchingTransition(transitions.data, transitionName);
    if (!match) {
      const available = transitions.data.map(formatTransition).join(', ');
      return {
        success: false,
        error: {
          code: 'TRANSITION_NOT_FOUND',
          message: `Transition "${transitionName}" not found for ${ticketKey}. Available: ${available}`,
        },
      };
    }

    return this.applyTransition(ticketKey, match);
  }

  /** Walk available transitions until the ticket reaches a target status. */
  async transitionTicketToStatus(
    ticketKey: string,
    targetStatus: string,
    options: { transitionPath?: string[]; maxSteps?: number } = {},
  ): Promise<JiraResult<JiraTransitionPathResult>> {
    const appliedTransitions: string[] = [];
    const maxSteps = options.maxSteps ?? 8;
    const preferredPath =
      options.transitionPath && options.transitionPath.length > 0
        ? options.transitionPath
        : DEFAULT_TRANSITION_PATH;

    for (let step = 0; step <= maxSteps; step += 1) {
      const statusResult = await this.getTicketStatus(ticketKey);
      if (!statusResult.success || !statusResult.data) {
        return { success: false, error: statusResult.error };
      }

      if (normalizeJiraName(statusResult.data) === normalizeJiraName(targetStatus)) {
        return {
          success: true,
          data: { status: statusResult.data, appliedTransitions },
        };
      }

      if (step === maxSteps) {
        return {
          success: false,
          error: {
            code: 'TRANSITION_MAX_STEPS',
            message: `Could not reach ${targetStatus} for ${ticketKey} after ${maxSteps} transition step(s). Current status: ${statusResult.data}`,
          },
        };
      }

      const transitions = await this.getTicketTransitions(ticketKey);
      if (!transitions.success || !transitions.data) {
        return { success: false, error: transitions.error };
      }

      const directMatch = findMatchingTransition(transitions.data, targetStatus);
      const nextMatch =
        directMatch ??
        preferredPath
          .map((candidate) => findMatchingTransition(transitions.data!, candidate))
          .find((candidate): candidate is JiraTransition => candidate !== undefined);

      if (!nextMatch) {
        const available = transitions.data.map(formatTransition).join(', ');
        return {
          success: false,
          error: {
            code: 'TRANSITION_PATH_NOT_FOUND',
            message: `Could not transition ${ticketKey} from "${statusResult.data}" to "${targetStatus}". Available: ${available}. Provide --transition-path with the required workflow hops if this project uses a custom path.`,
          },
        };
      }

      const transitionResult = await this.applyTransition(ticketKey, nextMatch);
      if (!transitionResult.success) {
        return { success: false, error: transitionResult.error };
      }
      appliedTransitions.push(formatTransition(nextMatch));
    }

    return {
      success: false,
      error: {
        code: 'TRANSITION_UNREACHABLE',
        message: `Could not reach ${targetStatus} for ${ticketKey}.`,
      },
    };
  }

  private async applyTransition(
    ticketKey: string,
    transition: JiraTransition,
  ): Promise<JiraResult<void>> {
    return this.request<void>('POST', `/rest/api/3/issue/${ticketKey}/transitions`, {
      transition: { id: transition.id },
    });
  }

  /** Resolve a Jira Cloud user from display name, email, or search query. */
  async resolveUser(query: string): Promise<JiraResult<JiraUser>> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return {
        success: false,
        error: { code: 'EMPTY_USER_QUERY', message: 'Assignee query cannot be empty.' },
      };
    }

    const result = await this.request<JiraUser[]>(
      'GET',
      `/rest/api/3/user/search?query=${encodeURIComponent(trimmedQuery)}&maxResults=10`,
    );
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? { code: 'USER_SEARCH_FAILED', message: 'User search failed.' },
      };
    }

    const activeUsers = result.data.filter((user) => user.active !== false);
    const normalized = normalizeJiraName(trimmedQuery);
    const exactEmail = activeUsers.find(
      (user) => user.emailAddress && normalizeJiraName(user.emailAddress) === normalized,
    );
    const exactDisplayName = activeUsers.find(
      (user) => normalizeJiraName(user.displayName) === normalized,
    );
    const selected =
      exactEmail ?? exactDisplayName ?? (activeUsers.length === 1 ? activeUsers[0] : null);

    if (!selected) {
      const candidates = activeUsers.map((user) => user.displayName).join(', ') || 'none';
      return {
        success: false,
        error: {
          code: 'USER_NOT_UNIQUE',
          message: `Could not uniquely resolve assignee "${trimmedQuery}". Candidates: ${candidates}`,
        },
      };
    }

    return { success: true, data: selected };
  }

  /** Assign a ticket to a Jira user resolved by display name, email, or search query. */
  async assignTicket(ticketKey: string, assigneeQuery: string): Promise<JiraResult<JiraUser>> {
    const user = await this.resolveUser(assigneeQuery);
    if (!user.success || !user.data) {
      return { success: false, error: user.error };
    }

    const assignResult = await this.assignTicketToAccountId(ticketKey, user.data.accountId);
    if (!assignResult.success) {
      return { success: false, error: assignResult.error };
    }

    return { success: true, data: user.data };
  }

  /** Assign a ticket directly to a Jira Cloud accountId. */
  async assignTicketToAccountId(ticketKey: string, accountId: string): Promise<JiraResult<void>> {
    return this.request<void>('PUT', `/rest/api/3/issue/${ticketKey}/assignee`, {
      accountId,
    });
  }

  /** Attach one or more evidence files to a Jira ticket. */
  async attachFiles(ticketKey: string, filePaths: string[]): Promise<JiraResult<string[]>> {
    if (!this.configured) {
      return {
        success: false,
        error: {
          code: 'NOT_CONFIGURED',
          message:
            'Jira env vars missing (JIRA_BASE_URL/ATLASSIAN_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/ATLASSIAN_API_KEY)',
        },
      };
    }

    const attached: string[] = [];
    for (const filePath of filePaths) {
      try {
        const bytes = await readFile(filePath);
        const form = new FormData();
        form.append('file', new Blob([bytes]), basename(filePath));

        const response = await fetch(`${this.baseUrl}/rest/api/3/issue/${ticketKey}/attachments`, {
          method: 'POST',
          headers: {
            Authorization: this.authHeader(),
            Accept: 'application/json',
            'X-Atlassian-Token': 'no-check',
          },
          body: form,
        });

        if (!response.ok) {
          const text = await response.text();
          return {
            success: false,
            error: {
              code: `HTTP_${response.status}`,
              message: `Attach ${filePath} to ${ticketKey} failed (${response.status}): ${text.slice(0, 500)}`,
            },
          };
        }

        attached.push(filePath);
      } catch (err) {
        return {
          success: false,
          error: {
            code: 'ATTACHMENT_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    return { success: true, data: attached };
  }

  /** Add a comment to a ticket. */
  async addComment(ticketKey: string, commentText: string): Promise<JiraResult<void>> {
    return this.request<void>('POST', `/rest/api/3/issue/${ticketKey}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: commentText,
              },
            ],
          },
        ],
      },
    });
  }

  /** Batch-fetch summaries for multiple ticket keys. */
  async getTicketSummaries(ticketKeys: string[]): Promise<JiraResult<TicketSummary[]>> {
    if (ticketKeys.length === 0) {
      return { success: true, data: [] };
    }

    const summaries: TicketSummary[] = [];
    // Fetch in parallel, batches of 10 to avoid rate limits
    const batchSize = 10;
    for (let i = 0; i < ticketKeys.length; i += batchSize) {
      const batch = ticketKeys.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((key) => this.getTicket(key)));
      for (const result of results) {
        if (result.success && result.data) {
          summaries.push({
            key: result.data.key,
            summary: result.data.fields.summary,
            status: result.data.fields.status.name,
          });
        }
      }
    }

    return { success: true, data: summaries };
  }

  // ── Search & Queries ────────────────────────────────────────────────────

  /**
   * Search tickets using JQL (Jira Query Language).
   * Returns tickets with summary, status, and created date.
   *
   * @param jql - JQL query string (e.g., 'reporter = currentUser() ORDER BY created DESC')
   * @param maxResults - Maximum number of results (default: 50)
   */
  async searchTickets(jql: string, maxResults = 50): Promise<JiraResult<TicketSummary[]>> {
    const result = await this.request<{
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          status: { name: string };
        };
      }>;
    }>('POST', '/rest/api/3/search/jql', {
      jql,
      maxResults,
      fields: ['summary', 'status'],
    });

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error ?? { code: 'NO_DATA', message: 'Search returned no data' },
      };
    }

    const summaries: TicketSummary[] = result.data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
    }));

    return { success: true, data: summaries };
  }

  /**
   * Get tickets created by the current user (from JIRA_EMAIL env var).
   * Excludes tickets in "Done" status by default.
   *
   * @param projectKey - Limit to specific project (e.g., 'ABLP')
   * @param maxResults - Maximum results (default: 50)
   * @param includeDone - Include Done tickets (default: false)
   */
  async getMyTickets(
    projectKey?: string,
    maxResults = 50,
    includeDone = false,
  ): Promise<JiraResult<TicketSummary[]>> {
    const baseConditions = [`reporter = "${this.email}"`];
    if (projectKey) {
      baseConditions.unshift(`project = "${projectKey}"`);
    }
    if (!includeDone) {
      baseConditions.push(`status != "Done"`);
    }
    const jql = `${baseConditions.join(' AND ')} ORDER BY created DESC`;
    return this.searchTickets(jql, maxResults);
  }

  /**
   * Get tickets assigned to the current user.
   * Excludes tickets in "Done" status by default.
   *
   * @param projectKey - Limit to specific project (e.g., 'ABLP')
   * @param maxResults - Maximum results (default: 50)
   * @param includeDone - Include Done tickets (default: false)
   */
  async getMyAssignedTickets(
    projectKey?: string,
    maxResults = 50,
    includeDone = false,
  ): Promise<JiraResult<TicketSummary[]>> {
    const baseConditions = [`assignee = "${this.email}"`];
    if (projectKey) {
      baseConditions.unshift(`project = "${projectKey}"`);
    }
    if (!includeDone) {
      baseConditions.push(`status != "Done"`);
    }
    const jql = `${baseConditions.join(' AND ')} ORDER BY updated DESC`;
    return this.searchTickets(jql, maxResults);
  }
}
