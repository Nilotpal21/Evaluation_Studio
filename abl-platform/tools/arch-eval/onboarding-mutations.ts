/**
 * Arch-AI onboarding mutation harness.
 *
 * Drives the same /api/arch-ai/* HTTP+SSE routes as the browser and
 * kore-platform-cli, but intentionally avoids the pure happy path. Each
 * mutation stresses a phase transition or session restore edge:
 *   - create from free text after the BuildComplete widget appears
 *   - request topology changes before accepting blueprint
 *   - reject/restart topology before accepting blueprint
 *   - replay a stale BuildComplete answer after project creation
 *
 * Artifacts are written under docs/testing/arch-eval/<run-id>/ by default.
 */

import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decideReply, type InteractiveToolEvent } from './auto-reply.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

type StreamEnd = 'turn_ended' | 'error' | 'eof' | 'timeout';

interface CliArgs {
  email: string;
  studioUrl: string;
  outputRoot: string;
  runId: string;
  only?: Set<string>;
  max?: number;
}

interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

interface SessionDetail {
  success?: boolean;
  session?: {
    id: string;
    state: string;
    metadata: Record<string, unknown>;
  };
  resume?: unknown;
}

interface ProjectAgent {
  name: string;
  dslContent?: string;
  ablContent?: string;
  dslValidationStatus?: string;
  dslDiagnostics?: unknown;
  compileResult?: unknown;
}

interface MutationContext {
  scenario: Scenario;
  mutationId: string;
  outDir: string;
  token: string;
  studioUrl: string;
  sessionId: string;
  eventsFile: string;
  interactiveQueue: InteractiveToolEvent[];
  errors: MutationIssue[];
  turnHistory: Array<{ tool: string; question?: string }>;
  counters: Record<string, number>;
  stored: Record<string, unknown>;
}

interface MutationIssue {
  stage: string;
  severity: 'info' | 'warn' | 'error';
  reason: string;
  timestamp: string;
}

interface MutationResult {
  mutationId: string;
  scenarioId: string;
  status: 'passed' | 'failed';
  projectId?: string;
  projectSlug?: string;
  durationMs: number;
  turnCount: number;
  eventCount: number;
  errorCount: number;
  warningCount: number;
  notes: string[];
}

interface MutationCase {
  id: string;
  scenario: Scenario;
  description: string;
  decideReply: (
    event: InteractiveToolEvent,
    ctx: MutationContext,
  ) => { kind: 'answer'; answer: unknown } | { kind: 'skip'; reason: string };
  onIdle?: (
    session: NonNullable<SessionDetail['session']>,
    ctx: MutationContext,
  ) => Promise<{ kind: 'message'; text: string } | { kind: 'create' } | { kind: 'none' }>;
  afterProject?: (ctx: MutationContext, projectId: string) => Promise<void>;
}

const STREAM_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 60 * 1000;
const MAX_TURNS = 90;

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function widgetType(event: InteractiveToolEvent): string | undefined {
  return typeof event.payload.widgetType === 'string' ? event.payload.widgetType : undefined;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage:
  pnpm exec tsx tools/arch-eval/onboarding-mutations.ts \\
    --run-id onboarding-mutations-$(date +%Y%m%d-%H%M%S) \\
    [--email test@example.com] [--studio http://localhost:5173] \\
    [--only m01-build-reload-create-text,m02-blueprint-request-changes] [--max 2]

Runs real Arch AI onboarding mutations through /api/arch-ai HTTP+SSE routes.
`);
    process.exit(0);
  }

  const args: Partial<CliArgs> = {
    email: 'test@example.com',
    studioUrl: 'http://localhost:5173',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') args.email = argv[++i];
    else if (arg === '--studio') args.studioUrl = argv[++i];
    else if (arg === '--run-id') args.runId = argv[++i];
    else if (arg === '--output-root') args.outputRoot = argv[++i];
    else if (arg === '--only') args.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    else if (arg === '--max') args.max = Number.parseInt(argv[++i] ?? '0', 10) || undefined;
  }

  if (!args.runId) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    args.runId = `mutation-${ts}`;
  }
  if (!args.outputRoot) {
    args.outputRoot = path.join(process.cwd(), 'docs/testing/arch-eval', args.runId);
  }

  return args as CliArgs;
}

async function readResponseSnippet(res: Response): Promise<string> {
  const text = await res.text().catch(() => res.statusText);
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

async function devLogin(studioUrl: string, email: string): Promise<string> {
  const res = await fetch(`${studioUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'Arch Mutation Bot' }),
  });
  if (!res.ok) {
    throw new Error(`dev-login failed: ${res.status} ${await readResponseSnippet(res)}`);
  }
  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) {
    throw new Error('dev-login returned no accessToken');
  }
  return data.accessToken;
}

async function postJson<T>(
  url: string,
  body: unknown,
  token: string,
): Promise<{ ok: boolean; status: number; data?: T; text?: string }> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { ok: false, status: res.status, text: await readResponseSnippet(res) };
      }
      return { ok: true, status: res.status, data: (await res.json()) as T };
    } catch (err) {
      lastError = describeError(err);
      await sleep(1_000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, text: lastError ?? 'fetch failed' };
}

async function getJson<T>(
  url: string,
  token: string,
): Promise<{ ok: boolean; status: number; data?: T; text?: string }> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { ok: false, status: res.status, text: await readResponseSnippet(res) };
      }
      return { ok: true, status: res.status, data: (await res.json()) as T };
    } catch (err) {
      lastError = describeError(err);
      await sleep(1_000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, text: lastError ?? 'fetch failed' };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function appendNdjson(filePath: string, data: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(data)}\n`, 'utf8');
}

async function streamMessage(
  ctx: Pick<MutationContext, 'studioUrl' | 'token' | 'eventsFile' | 'interactiveQueue'>,
  body: unknown,
): Promise<{ endedReason: StreamEnd; errorMessage?: string; eventCount: number }> {
  const events: SSEEvent[] = [];
  const queue: SSEEvent[] = [];
  let endedReason: StreamEnd = 'eof';
  let errorMessage: string | undefined;

  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    endedReason = 'timeout';
    ctrl.abort();
  }, STREAM_TIMEOUT_MS);

  try {
    const res = await fetch(`${ctx.studioUrl}/api/arch-ai/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      endedReason = 'error';
      errorMessage = `Stream HTTP ${res.status}: ${await readResponseSnippet(res)}`;
      return { endedReason, errorMessage, eventCount: events.length };
    }

    const parser = createParser({
      onEvent(msg: EventSourceMessage) {
        if (!msg.data) {
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const event: SSEEvent = { type: msg.event ?? 'unknown', ...parsed };
        events.push(event);
        queue.push(event);
        if (event.type === 'error') {
          endedReason = 'error';
          const err = event.error;
          errorMessage = isRecord(err) ? String(err.message ?? 'stream error') : 'stream error';
        }
      },
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parser.feed(decoder.decode(value, { stream: true }));
      while (queue.length > 0) {
        const event = queue.shift();
        if (!event) {
          continue;
        }
        await appendNdjson(ctx.eventsFile, event);
        const normalized = normalizeInteractiveEvent(event);
        if (normalized) {
          ctx.interactiveQueue.push(normalized);
        }
      }
    }

    while (queue.length > 0) {
      const event = queue.shift();
      if (!event) {
        continue;
      }
      await appendNdjson(ctx.eventsFile, event);
      const normalized = normalizeInteractiveEvent(event);
      if (normalized) {
        ctx.interactiveQueue.push(normalized);
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) {
      endedReason = 'error';
      errorMessage = describeError(err);
    }
  } finally {
    clearTimeout(timer);
  }

  return { endedReason, errorMessage, eventCount: events.length };
}

function normalizeInteractiveEvent(event: SSEEvent): InteractiveToolEvent | null {
  if (event.type === 'interactive_tool') {
    return event as unknown as InteractiveToolEvent;
  }

  if (event.type !== 'tool_call') {
    return null;
  }

  const tool = typeof event.toolName === 'string' ? event.toolName : undefined;
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
  if (!tool || !toolCallId || (tool !== 'ask_user' && tool !== 'collect_file')) {
    return null;
  }

  return {
    type: 'interactive_tool',
    tool,
    toolCallId,
    kind: 'tool',
    payload: isRecord(event.input) ? event.input : {},
  };
}

function defaultAnswer(event: InteractiveToolEvent, ctx: MutationContext): unknown {
  const decision = decideReply(event, ctx.scenario, ctx.turnHistory);
  if (decision.kind === 'answer') {
    return decision.answer;
  }
  throw new Error(decision.reason);
}

function note(
  ctx: MutationContext,
  severity: MutationIssue['severity'],
  stage: string,
  reason: string,
): void {
  ctx.errors.push({ stage, severity, reason, timestamp: nowIso() });
}

function mutationCases(scenarios: Scenario[]): MutationCase[] {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const insurance = byId.get('s11-insurance-claims') ?? scenarios[0];
  const telco = byId.get('s12-telco-billing-dispute') ?? scenarios[1] ?? insurance;
  const saas = byId.get('s14-b2b-saas-onboarding') ?? scenarios[2] ?? insurance;
  const field = byId.get('s19-field-service-dispatch') ?? scenarios[3] ?? insurance;

  return [
    {
      id: 'm01-build-reload-create-text',
      scenario: insurance,
      description:
        'Stop at BuildComplete, fetch session/resume snapshots, then create using free-text instead of the widget button.',
      decideReply(event, ctx) {
        if (widgetType(event) === 'BuildComplete') {
          ctx.stored.buildCompleteToolCallId = event.toolCallId;
          ctx.stored.buildCompletePayload = event.payload;
          return { kind: 'skip', reason: 'defer BuildComplete to free-text create mutation' };
        }
        return { kind: 'answer', answer: defaultAnswer(event, ctx) };
      },
      async onIdle(session, ctx) {
        if (
          session.metadata.phase === 'BUILD' &&
          isRecord(session.metadata.pendingInteraction) &&
          isRecord(session.metadata.pendingInteraction.payload) &&
          session.metadata.pendingInteraction.payload.widgetType === 'BuildComplete' &&
          ctx.stored.createTextSent !== true
        ) {
          await writeJson(path.join(ctx.outDir, 'resume-before-create-text.json'), {
            session,
            fetchedAt: nowIso(),
          });
          ctx.stored.createTextSent = true;
          return { kind: 'message', text: 'Looks good, go ahead and create the project now.' };
        }
        return { kind: 'none' };
      },
    },
    {
      id: 'm02-blueprint-request-changes',
      scenario: telco,
      description:
        'Request changes on the first topology, answer the revision widget, then accept the regenerated topology.',
      decideReply(event, ctx) {
        const type = widgetType(event);
        if (type === 'TopologyApproval') {
          ctx.counters.topologyApproval = (ctx.counters.topologyApproval ?? 0) + 1;
          if (ctx.counters.topologyApproval === 1) {
            return {
              kind: 'answer',
              answer: {
                action: 'request_changes',
                notes:
                  'Reduce unnecessary cross-agent handoffs and make Spanish billing-dispute routing explicit.',
              },
            };
          }
          return { kind: 'answer', answer: { action: 'accept' } };
        }
        if (type === 'TopologyRevision') {
          return {
            kind: 'answer',
            answer: {
              targets: ['handoffs', 'responsibilities'],
              notes:
                'Keep the flow practical: authenticate once, then route by dispute type and escalation threshold.',
            },
          };
        }
        return { kind: 'answer', answer: defaultAnswer(event, ctx) };
      },
    },
    {
      id: 'm03-blueprint-reject-restart',
      scenario: saas,
      description:
        'Reject the first topology entirely, provide restart guidance, then accept the replacement topology.',
      decideReply(event, ctx) {
        const type = widgetType(event);
        if (type === 'TopologyApproval') {
          ctx.counters.topologyApproval = (ctx.counters.topologyApproval ?? 0) + 1;
          if (ctx.counters.topologyApproval === 1) {
            return {
              kind: 'answer',
              answer: {
                action: 'reject',
                notes:
                  'Restart with a simpler onboarding coordinator, one integration specialist, and one success handoff.',
              },
            };
          }
          return { kind: 'answer', answer: { action: 'accept' } };
        }
        if (type === 'TopologyRevision') {
          return {
            kind: 'answer',
            answer: {
              targets: ['agents', 'pattern'],
              notes:
                'Prefer fewer agents and a clear coordinator pattern over a broad mesh of specialists.',
            },
          };
        }
        return { kind: 'answer', answer: defaultAnswer(event, ctx) };
      },
    },
    {
      id: 'm04-stale-build-widget-replay',
      scenario: field,
      description:
        'Create from BuildComplete, then replay the same stale widget answer to verify it fails fast rather than freezing.',
      decideReply(event, ctx) {
        if (widgetType(event) === 'BuildComplete') {
          ctx.stored.buildCompleteToolCallId = event.toolCallId;
        }
        return { kind: 'answer', answer: defaultAnswer(event, ctx) };
      },
      async afterProject(ctx) {
        const toolCallId =
          typeof ctx.stored.buildCompleteToolCallId === 'string'
            ? ctx.stored.buildCompleteToolCallId
            : null;
        if (!toolCallId) {
          note(ctx, 'warn', 'stale_replay_skipped', 'No BuildComplete toolCallId was captured.');
          return;
        }

        const replay = await streamMessage(ctx, {
          sessionId: ctx.sessionId,
          type: 'tool_answer',
          toolCallId,
          answer: 'create',
        });
        await writeJson(path.join(ctx.outDir, 'stale-replay-result.json'), replay);
        if (replay.endedReason === 'timeout') {
          note(ctx, 'error', 'stale_replay_timeout', 'Stale BuildComplete replay timed out.');
        } else {
          note(
            ctx,
            'info',
            'stale_replay_completed',
            `Stale replay ended with ${replay.endedReason}${replay.errorMessage ? `: ${replay.errorMessage}` : ''}.`,
          );
        }
      },
    },
  ];
}

async function fetchProjectArtifacts(
  ctx: MutationContext,
  projectId: string,
): Promise<string | undefined> {
  const project = await getJson<{ project?: { slug?: string; agents?: ProjectAgent[] } }>(
    `${ctx.studioUrl}/api/projects/${encodeURIComponent(projectId)}`,
    ctx.token,
  );
  await writeJson(
    path.join(ctx.outDir, project.ok ? 'project.json' : 'project.error.json'),
    project.ok ? project.data : project,
  );

  const agents = await getJson<{ agents?: ProjectAgent[]; data?: ProjectAgent[] }>(
    `${ctx.studioUrl}/api/projects/${encodeURIComponent(projectId)}/agents`,
    ctx.token,
  );
  await writeJson(
    path.join(ctx.outDir, agents.ok ? 'agents.json' : 'agents.error.json'),
    agents.ok ? agents.data : agents,
  );

  const health = await getJson<unknown>(
    `${ctx.studioUrl}/api/arch-ai/project-health?projectId=${encodeURIComponent(projectId)}`,
    ctx.token,
  );
  await writeJson(
    path.join(ctx.outDir, health.ok ? 'health.json' : 'health.error.json'),
    health.ok ? health.data : health,
  );

  const agentList = agents.data?.agents ?? agents.data?.data ?? [];
  const ablDir = path.join(ctx.outDir, 'abl');
  await fs.mkdir(ablDir, { recursive: true });
  for (const agent of agentList) {
    const dsl = agent.dslContent ?? agent.ablContent;
    if (dsl) {
      await fs.writeFile(path.join(ablDir, `${agent.name}.abl`), dsl, 'utf8');
    }
  }

  return project.data?.project?.slug;
}

async function getSession(ctx: Pick<MutationContext, 'studioUrl' | 'token' | 'sessionId'>) {
  return getJson<SessionDetail>(
    `${ctx.studioUrl}/api/arch-ai/sessions/${encodeURIComponent(ctx.sessionId)}`,
    ctx.token,
  );
}

async function sendTurn(
  ctx: MutationContext,
  body: { sessionId: string; type: 'message' | 'tool_answer' | 'create'; [key: string]: unknown },
): Promise<void> {
  const result = await streamMessage(ctx, body);
  if (result.endedReason === 'error' || result.endedReason === 'timeout') {
    note(
      ctx,
      'error',
      `stream:${body.type}`,
      result.errorMessage ?? `stream ended with ${result.endedReason}`,
    );
  }
}

async function runMutation(
  testCase: MutationCase,
  args: CliArgs,
  token: string,
): Promise<MutationResult> {
  const startedAt = Date.now();
  const outDir = path.join(args.outputRoot, testCase.id);
  await fs.mkdir(outDir, { recursive: true });
  const eventsFile = path.join(outDir, 'events.ndjson');
  await fs.writeFile(eventsFile, '', 'utf8');

  const createRes = await postJson<{ sessionId: string }>(
    `${args.studioUrl}/api/arch-ai/sessions`,
    { force: true, threadId: `mutation-${testCase.id}-${Date.now().toString(36)}` },
    token,
  );
  if (!createRes.ok || !createRes.data?.sessionId) {
    return {
      mutationId: testCase.id,
      scenarioId: testCase.scenario.id,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      turnCount: 0,
      eventCount: 0,
      errorCount: 1,
      warningCount: 0,
      notes: [`session_create failed: ${createRes.text ?? createRes.status}`],
    };
  }

  const ctx: MutationContext = {
    scenario: testCase.scenario,
    mutationId: testCase.id,
    outDir,
    token,
    studioUrl: args.studioUrl,
    sessionId: createRes.data.sessionId,
    eventsFile,
    interactiveQueue: [],
    errors: [],
    turnHistory: [],
    counters: {},
    stored: {},
  };

  await writeJson(path.join(outDir, 'mutation.json'), {
    id: testCase.id,
    description: testCase.description,
    scenario: testCase.scenario,
    sessionId: ctx.sessionId,
  });

  let turnCount = 0;
  let projectId: string | undefined;
  let projectSlug: string | undefined;

  await sendTurn(ctx, {
    sessionId: ctx.sessionId,
    type: 'message',
    text: testCase.scenario.seedMessage,
  });
  turnCount += 1;

  for (; turnCount < MAX_TURNS; turnCount += 1) {
    if (ctx.errors.some((issue) => issue.severity === 'error')) {
      break;
    }

    const next = ctx.interactiveQueue.shift();
    if (next) {
      const question =
        typeof next.payload.question === 'string' ? next.payload.question : undefined;
      ctx.turnHistory.push({ tool: next.tool, question });
      const decision = testCase.decideReply(next, ctx);
      if (decision.kind === 'skip') {
        note(ctx, 'info', `skip:${next.toolCallId}`, decision.reason);
        continue;
      }
      await sendTurn(ctx, {
        sessionId: ctx.sessionId,
        type: 'tool_answer',
        toolCallId: next.toolCallId,
        answer: decision.answer,
      });
      continue;
    }

    const sessionRes = await getSession(ctx);
    if (!sessionRes.ok || !sessionRes.data?.session) {
      note(ctx, 'error', 'session_fetch', sessionRes.text ?? 'session fetch failed');
      break;
    }

    await writeJson(path.join(outDir, `session-${String(turnCount).padStart(2, '0')}.json`), {
      fetchedAt: nowIso(),
      session: sessionRes.data.session,
      resume: sessionRes.data.resume,
    });

    projectId =
      typeof sessionRes.data.session.metadata.projectId === 'string'
        ? sessionRes.data.session.metadata.projectId
        : undefined;
    if (projectId) {
      await writeJson(path.join(outDir, 'session.json'), sessionRes.data);
      if (sessionRes.data.session.metadata.topology) {
        await writeJson(
          path.join(outDir, 'topology.json'),
          sessionRes.data.session.metadata.topology,
        );
      }
      projectSlug = await fetchProjectArtifacts(ctx, projectId);
      await testCase.afterProject?.(ctx, projectId);
      break;
    }

    const action = await testCase.onIdle?.(sessionRes.data.session, ctx);
    if (action?.kind === 'message') {
      await sendTurn(ctx, { sessionId: ctx.sessionId, type: 'message', text: action.text });
      continue;
    }
    if (action?.kind === 'create') {
      await sendTurn(ctx, { sessionId: ctx.sessionId, type: 'create' });
      continue;
    }

    const phase =
      typeof sessionRes.data.session.metadata.phase === 'string'
        ? sessionRes.data.session.metadata.phase
        : '?';
    const pending = sessionRes.data.session.metadata.pendingInteraction;
    if (phase === 'CREATE' && !pending) {
      await sendTurn(ctx, { sessionId: ctx.sessionId, type: 'create' });
      continue;
    }
    if (phase === 'BLUEPRINT' && !pending) {
      await sendTurn(ctx, {
        sessionId: ctx.sessionId,
        type: 'message',
        text: 'Generate the draft topology now.',
      });
      continue;
    }
    if (phase === 'INTERVIEW' && !pending) {
      await sendTurn(ctx, {
        sessionId: ctx.sessionId,
        type: 'message',
        text: 'Proceed to design the architecture.',
      });
      continue;
    }

    note(
      ctx,
      'error',
      'no_progress',
      `No queued widget and no safe idle action in phase ${phase}.`,
    );
    break;
  }

  if (!projectId) {
    const finalSession = await getSession(ctx);
    if (finalSession.ok) {
      await writeJson(path.join(outDir, 'session-final.json'), finalSession.data);
      projectId =
        typeof finalSession.data?.session?.metadata.projectId === 'string'
          ? finalSession.data.session.metadata.projectId
          : undefined;
      if (projectId) {
        await writeJson(path.join(outDir, 'session.json'), finalSession.data);
        if (finalSession.data?.session?.metadata.topology) {
          await writeJson(
            path.join(outDir, 'topology.json'),
            finalSession.data.session.metadata.topology,
          );
        }
        projectSlug = await fetchProjectArtifacts(ctx, projectId);
      }
    }
  }

  try {
    await postJson(
      `${args.studioUrl}/api/arch-ai/sessions/${encodeURIComponent(ctx.sessionId)}/archive`,
      {},
      token,
    );
  } catch (err) {
    note(ctx, 'warn', 'session_archive', describeError(err));
  }

  const rawEvents = await fs.readFile(eventsFile, 'utf8');
  const eventCount = rawEvents.split('\n').filter(Boolean).length;
  const errors = ctx.errors.filter((issue) => issue.severity === 'error');
  const warnings = ctx.errors.filter((issue) => issue.severity === 'warn');
  await writeJson(path.join(outDir, 'issues.json'), ctx.errors);

  const result: MutationResult = {
    mutationId: testCase.id,
    scenarioId: testCase.scenario.id,
    status: projectId && errors.length === 0 ? 'passed' : 'failed',
    projectId,
    projectSlug,
    durationMs: Date.now() - startedAt,
    turnCount,
    eventCount,
    errorCount: errors.length,
    warningCount: warnings.length,
    notes: ctx.errors.map((issue) => `${issue.severity}:${issue.stage}: ${issue.reason}`),
  };
  await writeJson(path.join(outDir, 'final.json'), result);
  return result;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

async function writeSummary(outputRoot: string, results: MutationResult[]): Promise<void> {
  await writeJson(path.join(outputRoot, 'summary.json'), results);
  const lines: string[] = [];
  lines.push('# Arch-AI Onboarding Mutation Run');
  lines.push('');
  lines.push(`**Generated**: ${nowIso()}`);
  lines.push(`**Mutations**: ${results.length}`);
  lines.push(
    `**Passed**: ${results.filter((result) => result.status === 'passed').length}/${results.length}`,
  );
  lines.push('');
  lines.push('| Mutation | Scenario | Status | Duration | Turns | Events | Project | Issues |');
  lines.push('|---|---|---|---|---:|---:|---|---|');
  for (const result of results) {
    lines.push(
      `| ${result.mutationId} | ${result.scenarioId} | ${result.status} | ${fmtDuration(result.durationMs)} | ${result.turnCount} | ${result.eventCount} | ${result.projectSlug ?? result.projectId ?? '-'} | ${result.errorCount} errors, ${result.warningCount} warnings |`,
    );
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const result of results) {
    if (result.notes.length === 0) {
      continue;
    }
    lines.push(`### ${result.mutationId}`);
    for (const noteLine of result.notes) {
      lines.push(`- ${noteLine}`);
    }
    lines.push('');
  }
  await fs.writeFile(path.join(outputRoot, 'summary.md'), lines.join('\n'), 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  await fs.mkdir(args.outputRoot, { recursive: true });
  const token = await devLogin(args.studioUrl, args.email);
  let cases = mutationCases(SCENARIOS);
  if (args.only?.size) {
    cases = cases.filter((testCase) => args.only?.has(testCase.id));
  }
  if (args.max) {
    cases = cases.slice(0, args.max);
  }

  const scenarioById = new Map(cases.map((testCase) => [testCase.scenario.id, testCase.scenario]));
  await writeJson(path.join(args.outputRoot, 'scenarios.json'), [...scenarioById.values()]);

  process.stdout.write(`[arch-mutations] output: ${args.outputRoot}\n`);
  const results: MutationResult[] = [];
  for (const testCase of cases) {
    process.stdout.write(`[arch-mutations] === ${testCase.id} (${testCase.scenario.id}) ===\n`);
    const result = await runMutation(testCase, args, token);
    results.push(result);
    process.stdout.write(
      `[arch-mutations] ${result.status} ${testCase.id} ${fmtDuration(result.durationMs)} project=${result.projectSlug ?? result.projectId ?? '-'} issues=${result.errorCount}/${result.warningCount}\n`,
    );
    await sleep(500);
  }

  await writeSummary(args.outputRoot, results);
  const failures = results.filter((result) => result.status === 'failed');
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[arch-mutations] fatal: ${describeError(err)}\n`);
  process.exit(1);
});
