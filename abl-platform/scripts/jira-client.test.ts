import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildAdfDescription, JiraClient } from './jira-client.js';

const jiraBaseUrl = 'https://jira.example.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

beforeEach(() => {
  vi.stubEnv('JIRA_BASE_URL', jiraBaseUrl);
  vi.stubEnv('JIRA_EMAIL', 'dev@example.com');
  vi.stubEnv('JIRA_API_TOKEN', 'test-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildAdfDescription', () => {
  it('renders QA bullet lists as Jira bulletList nodes', () => {
    const doc = buildAdfDescription([
      {
        heading: 'Shipped',
        content: [
          '- Centralized workspace permissions',
          '- Added focused regression coverage',
        ].join('\n'),
      },
    ]);

    expect(doc.content[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 3 },
    });
    expect(doc.content[1]).toMatchObject({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Centralized workspace permissions' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Added focused regression coverage' }],
            },
          ],
        },
      ],
    });
  });

  it('renders ordered lists and inline code marks', () => {
    const doc = buildAdfDescription([
      {
        heading: 'Verification',
        content: [
          '1. Ran `pnpm build --filter=@agent-platform/studio`',
          '2. Ran `pnpm jira:update -- --help`',
        ].join('\n'),
      },
    ]);

    expect(doc.content[1]).toMatchObject({
      type: 'orderedList',
    });

    const firstItemParagraph = (doc.content[1]?.content?.[0]?.content?.[0] ?? {}) as {
      content?: Array<{ text?: string; marks?: Array<{ type: string }> }>;
    };
    expect(firstItemParagraph.content).toEqual([
      { type: 'text', text: 'Ran ' },
      {
        type: 'text',
        text: 'pnpm build --filter=@agent-platform/studio',
        marks: [{ type: 'code' }],
      },
    ]);
  });

  it('keeps multi-line plain text as a paragraph with hard breaks', () => {
    const doc = buildAdfDescription([
      {
        heading: 'Remaining follow-up',
        content: [
          'Audit remaining Studio admin routes',
          'Keep E2E coverage as the guard rail',
        ].join('\n'),
      },
    ]);

    expect(doc.content[1]).toMatchObject({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Audit remaining Studio admin routes' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Keep E2E coverage as the guard rail' },
      ],
    });
  });

  it('formats escaped CLI newlines into subheadings, paragraphs, and lists', () => {
    const doc = buildAdfDescription([
      {
        heading: 'QA Note',
        content:
          'Root cause:\\nThe reasoning step could not update state.\\n\\nPost-fix checks passed:\\n- `pnpm build --filter=@agent-platform/runtime`\\n- Studio evidence attached',
      },
    ]);

    expect(doc.content[1]).toMatchObject({
      type: 'heading',
      attrs: { level: 4 },
      content: [{ type: 'text', text: 'Root cause:' }],
    });
    expect(doc.content[2]).toMatchObject({
      type: 'paragraph',
      content: [{ type: 'text', text: 'The reasoning step could not update state.' }],
    });
    expect(doc.content[3]).toMatchObject({
      type: 'heading',
      attrs: { level: 4 },
      content: [{ type: 'text', text: 'Post-fix checks passed:' }],
    });
    expect(doc.content[4]).toMatchObject({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'pnpm build --filter=@agent-platform/runtime',
                  marks: [{ type: 'code' }],
                },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Studio evidence attached' }],
            },
          ],
        },
      ],
    });
  });
});

describe('JiraClient assignment helpers', () => {
  it('resolves an assignee by display name and assigns by accountId', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      requests.push({ url, init });

      if (url.pathname === '/rest/api/3/user/search') {
        expect(url.searchParams.get('query')).toBe('Prakash Rochkari');
        return jsonResponse([
          {
            accountId: 'acct-prakash',
            displayName: 'Prakash Rochkari',
            emailAddress: 'prakash.rochkari@example.com',
            active: true,
          },
        ]);
      }

      if (url.pathname === '/rest/api/3/issue/ABLP-1/assignee') {
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(String(init?.body))).toEqual({ accountId: 'acct-prakash' });
        return emptyResponse();
      }

      throw new Error(`Unexpected Jira request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const jira = new JiraClient();
    const result = await jira.assignTicket('ABLP-1', 'Prakash Rochkari');

    expect(result).toMatchObject({
      success: true,
      data: { displayName: 'Prakash Rochkari', accountId: 'acct-prakash' },
    });
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/rest/api/3/user/search',
      '/rest/api/3/issue/ABLP-1/assignee',
    ]);
  });
});

describe('JiraClient attachment helpers', () => {
  it('uploads evidence files with Jira attachment headers', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'jira-attach-'));
    const evidencePath = join(tempDir, 'evidence.txt');
    await writeFile(evidencePath, 'studio proof');

    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        expect(url.pathname).toBe('/rest/api/3/issue/ABLP-1/attachments');
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['X-Atlassian-Token']).toBe('no-check');
        expect(init?.body).toBeInstanceOf(FormData);
        return jsonResponse([{ filename: 'evidence.txt' }]);
      });
      vi.stubGlobal('fetch', fetchMock);

      const jira = new JiraClient();
      const result = await jira.attachFiles('ABLP-1', [evidencePath]);

      expect(result).toEqual({ success: true, data: [evidencePath] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('JiraClient transition helpers', () => {
  it('walks available workflow hops to a target status', async () => {
    let status = 'To Do';
    const appliedTransitions: string[] = [];

    const transitionsByStatus: Record<
      string,
      Array<{ id: string; name: string; to: { name: string } }>
    > = {
      'To Do': [
        { id: '7', name: 'WIP', to: { name: 'In Progress' } },
        { id: '31', name: 'In Review', to: { name: 'In Review' } },
      ],
      'In Progress': [{ id: '31', name: 'In Review', to: { name: 'In Review' } }],
      'In Review': [{ id: '91', name: 'Review Completed', to: { name: 'Development Completed' } }],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);

      if (
        url.pathname === '/rest/api/3/issue/ABLP-1' &&
        url.searchParams.get('fields') === 'status'
      ) {
        return jsonResponse({ fields: { status: { name: status } } });
      }

      if (url.pathname === '/rest/api/3/issue/ABLP-1/transitions' && init?.method !== 'POST') {
        return jsonResponse({ transitions: transitionsByStatus[status] ?? [] });
      }

      if (url.pathname === '/rest/api/3/issue/ABLP-1/transitions' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { transition: { id: string } };
        const transition = (transitionsByStatus[status] ?? []).find(
          (candidate) => candidate.id === body.transition.id,
        );
        if (!transition) {
          return jsonResponse({ errorMessages: ['Transition not found'] }, 400);
        }
        appliedTransitions.push(transition.name);
        status = transition.to.name;
        return emptyResponse();
      }

      throw new Error(`Unexpected Jira request: ${url.pathname}${url.search}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const jira = new JiraClient();
    const result = await jira.transitionTicketToStatus('ABLP-1', 'Development Completed', {
      transitionPath: ['WIP', 'In Review', 'Review Completed'],
    });

    expect(result).toEqual({
      success: true,
      data: {
        status: 'Development Completed',
        appliedTransitions: [
          'WIP -> In Progress',
          'In Review -> In Review',
          'Review Completed -> Development Completed',
        ],
      },
    });
    expect(appliedTransitions).toEqual(['WIP', 'In Review', 'Review Completed']);
  });
});
