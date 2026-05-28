#!/usr/bin/env npx tsx
/**
 * One-off fetcher for the 2026-05-16 triage batch.
 * Dumps each ticket's description (rendered) + comments to
 * docs/sdlc-logs/triage-2026-05-16/_raw/<KEY>.json.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadJiraEnvFromDotEnv } from './jira-update-lib.js';

loadJiraEnvFromDotEnv();

const KEYS = [
  'ABLP-1100',
  'ABLP-1066',
  'ABLP-1058',
  'ABLP-1019',
  'ABLP-1059',
  'ABLP-905',
  'ABLP-1032',
  'ABLP-1031',
  'ABLP-1010',
  'ABLP-900',
  'ABLP-986',
  'ABLP-974',
];

const OUT_DIR = join(process.cwd(), 'docs/sdlc-logs/triage-2026-05-16/_raw');

interface Creds {
  baseUrl: string;
  email: string;
  token: string;
}

function resolveCreds(): Creds {
  const baseUrl = process.env.JIRA_BASE_URL ?? process.env.ATLASSIAN_BASE_URL ?? '';
  const email = process.env.JIRA_EMAIL ?? '';
  const token = process.env.JIRA_API_TOKEN ?? process.env.ATLASSIAN_API_KEY ?? '';
  if (!baseUrl || !email || !token) {
    throw new Error(
      'Missing Jira env vars (JIRA_BASE_URL/ATLASSIAN_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/ATLASSIAN_API_KEY)',
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), email, token };
}

function authHeader(c: Creds): string {
  return `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`;
}

async function getJson(c: Creds, path: string): Promise<unknown> {
  const res = await fetch(`${c.baseUrl}${path}`, {
    headers: {
      Authorization: authHeader(c),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

interface RenderedFields {
  summary: string;
  status: { name: string };
  assignee: { displayName: string; emailAddress?: string } | null;
  reporter: { displayName: string; emailAddress?: string } | null;
  priority: { name: string } | null;
  labels: string[];
  created: string;
  updated: string;
  duedate: string | null;
  description: unknown;
}

interface IssueResponse {
  key: string;
  fields: RenderedFields;
  renderedFields: { description: string | null };
}

interface Comment {
  id: string;
  author: { displayName: string; emailAddress?: string };
  body: unknown;
  renderedBody?: string;
  created: string;
  updated: string;
}

interface CommentsResponse {
  comments: Comment[];
  total: number;
}

async function fetchOne(c: Creds, key: string) {
  const issue = (await getJson(
    c,
    `/rest/api/3/issue/${key}?expand=renderedFields,changelog`,
  )) as IssueResponse;
  const comments = (await getJson(
    c,
    `/rest/api/3/issue/${key}/comment?expand=renderedBody&orderBy=created&maxResults=200`,
  )) as CommentsResponse;
  return { issue, comments };
}

async function main() {
  const creds = resolveCreds();
  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all(
    KEYS.map(async (key) => {
      try {
        const data = await fetchOne(creds, key);
        const path = join(OUT_DIR, `${key}.json`);
        await writeFile(path, JSON.stringify(data, null, 2));
        console.log(`[ok] ${key} -> ${path}`);
      } catch (err) {
        console.error(`[fail] ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
