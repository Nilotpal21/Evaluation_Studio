/**
 * Run a single scenario through ONBOARDING and capture full artifacts.
 *
 * Drives the same /api/arch-ai/* HTTP+SSE routes the browser and the
 * kore-platform-cli use. Emits:
 *   events.ndjson           — every parsed SSE event (verbatim)
 *   timeline.json           — phase timings, tool-call counts
 *   project.json            — final session metadata snapshot
 *   topology.json           — locked topology (agents + edges + entryPoint)
 *   abl/<AgentName>.abl     — full ABL per agent (post-create fetch)
 *   compile/<AgentName>.json — per-agent compile result
 *   health.json             — project-health response
 *   summary.json            — project-summary response
 *   errors.json             — accumulated errors
 *   final.json              — top-level summary (status, durations, counts)
 */

import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decideReply, type InteractiveToolEvent } from './auto-reply.js';
import type { Scenario } from './scenarios.js';

interface Config {
  studioUrl: string;
  token: string;
  outputDir: string;
  budget?: EvalBudget;
}

interface SSEEvent {
  type: string;
  [k: string]: unknown;
}

interface StreamSummary {
  events: SSEEvent[];
  endedReason: 'turn_ended' | 'error' | 'eof' | 'timeout';
  errorMessage?: string;
}

const STREAM_TIMEOUT_MS = 12 * 60 * 1000; // match complex BUILD turns without masking real hangs
const FALLBACK_USD_PER_TOKEN = 0.00006;
const TRANSIENT_STREAM_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

export interface EvalBudget {
  maxCostUsd?: number;
  maxTokens?: number;
  costUsd: number;
  tokens: number;
  exceeded?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientProviderError(summary: StreamSummary): boolean {
  if (summary.endedReason !== 'error') return false;
  const message = (summary.errorMessage ?? '').toLowerCase();
  return (
    message.includes('enotfound') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('temporarily unavailable') ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('model_provider_unknown') ||
    message.includes('cannot connect to api')
  );
}

async function postJson<T>(
  url: string,
  body: unknown,
  token: string,
): Promise<{ ok: boolean; status: number; data?: T; text?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return { ok: false, status: res.status, text };
  }
  const data = (await res.json()) as T;
  return { ok: true, status: res.status, data };
}

async function getJson<T>(
  url: string,
  token: string,
): Promise<{ ok: boolean; status: number; data?: T; text?: string }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return { ok: false, status: res.status, text };
  }
  const data = (await res.json()) as T;
  return { ok: true, status: res.status, data };
}

async function streamMessage(
  cfg: Config,
  body: unknown,
  onEvent: (event: SSEEvent) => Promise<void>,
): Promise<StreamSummary> {
  const events: SSEEvent[] = [];
  const eventQueue: SSEEvent[] = [];
  let endedReason: StreamSummary['endedReason'] = 'eof';
  let errorMessage: string | undefined;

  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    endedReason = 'timeout';
    ctrl.abort();
  }, STREAM_TIMEOUT_MS);

  try {
    const res = await fetch(`${cfg.studioUrl}/api/arch-ai/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      endedReason = 'error';
      errorMessage = `Stream HTTP ${res.status}: ${text}`;
      return { events, endedReason, errorMessage };
    }

    const parser = createParser({
      onEvent(msg: EventSourceMessage) {
        if (!msg.data) return;
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const event: SSEEvent = { type: msg.event ?? 'unknown', ...payload };
        events.push(event);
        eventQueue.push(event);
        if (event.type === 'error') {
          endedReason = 'error';
          const err = event.error as { message?: string } | undefined;
          errorMessage = err?.message;
        }
      },
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (eventQueue.length > 0) {
        const next = eventQueue.shift();
        if (!next) break;
        await onEvent(next);
      }
    }
    while (eventQueue.length > 0) {
      const next = eventQueue.shift();
      if (!next) break;
      await onEvent(next);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Timeout already set endedReason.
    } else {
      endedReason = 'error';
      errorMessage = describeError(err);
    }
  } finally {
    clearTimeout(timer);
  }

  return { events, endedReason, errorMessage };
}

interface RunResult {
  scenarioId: string;
  status: 'completed' | 'failed';
  failureStage?: string;
  failureReason?: string;
  sessionId?: string;
  projectId?: string;
  projectSlug?: string;
  durationMs: number;
  phaseTimings: Record<string, number>;
  toolCallCounts: Record<string, number>;
  errorCount: number;
  agentCount?: number;
  tokenCount?: number;
  estimatedCostUsd?: number;
  buildTelemetry?: BuildTelemetrySummary;
}

interface BuildAgentTelemetry {
  agent: string;
  mode?: string;
  role?: string;
  status?: string;
  firstEventAtMs: number;
  lastEventAtMs: number;
  durationMs: number;
  stageCounts: Record<string, number>;
  stages: Array<{ stage: string; detail?: string; offsetMs: number }>;
  warningCount: number;
  errorCount: number;
  diagnosticCount: number;
  toolCount?: number;
  handoffCount?: number;
}

interface BuildTelemetrySummary {
  agentCount: number;
  buildEventCount: number;
  slowestAgent?: string;
  slowestAgentMs?: number;
  reconciledSummary?: unknown;
}

interface BuildTelemetry extends BuildTelemetrySummary {
  eventCounts: Record<string, number>;
  agents: BuildAgentTelemetry[];
}

async function appendNdjson(filePath: string, event: SSEEvent): Promise<void> {
  await fs.appendFile(filePath, JSON.stringify(event) + '\n', 'utf8');
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

interface SessionDetail {
  success?: boolean;
  session?: {
    id: string;
    state: string;
    metadata: Record<string, unknown>;
  };
}

interface ProjectAgent {
  name: string;
  agentPath?: string;
  description?: string;
  // Field naming differs across versions: dslContent (current) / ablContent (legacy)
  dslContent?: string;
  ablContent?: string;
  dslValidationStatus?: string;
  dslDiagnostics?: unknown;
  agentType?: string;
  executionMode?: string;
  compileResult?: unknown;
  warnings?: unknown[];
  errors?: unknown[];
}

interface ProjectDetail {
  success?: boolean;
  project?: {
    id: string;
    name: string;
    slug: string;
    tenantId: string;
    agents?: ProjectAgent[];
  };
}

async function fetchProjectArtifacts(
  cfg: Config,
  projectId: string,
  outDir: string,
): Promise<{
  summary?: unknown;
  health?: unknown;
  project?: ProjectDetail;
  agents: ProjectAgent[];
}> {
  const out = { summary: undefined, health: undefined, project: undefined } as {
    summary?: unknown;
    health?: unknown;
    project?: ProjectDetail;
  };

  const summaryRes = await getJson<{ summary: unknown }>(
    `${cfg.studioUrl}/api/arch-ai/project-summary?projectId=${encodeURIComponent(projectId)}`,
    cfg.token,
  );
  if (summaryRes.ok) {
    out.summary = summaryRes.data?.summary;
    await writeJson(path.join(outDir, 'summary.json'), summaryRes.data);
  } else {
    await writeJson(path.join(outDir, 'summary.error.json'), summaryRes);
  }

  const healthRes = await getJson<unknown>(
    `${cfg.studioUrl}/api/arch-ai/project-health?projectId=${encodeURIComponent(projectId)}`,
    cfg.token,
  );
  if (healthRes.ok) {
    out.health = healthRes.data;
    await writeJson(path.join(outDir, 'health.json'), healthRes.data);
  } else {
    await writeJson(path.join(outDir, 'health.error.json'), healthRes);
  }

  const projRes = await getJson<ProjectDetail>(
    `${cfg.studioUrl}/api/projects/${encodeURIComponent(projectId)}`,
    cfg.token,
  );
  if (projRes.ok) {
    out.project = projRes.data;
    await writeJson(path.join(outDir, 'project.json'), projRes.data);
  } else {
    await writeJson(path.join(outDir, 'project.error.json'), projRes);
  }

  const agentsRes = await getJson<{ agents?: ProjectAgent[]; data?: ProjectAgent[] }>(
    `${cfg.studioUrl}/api/projects/${encodeURIComponent(projectId)}/agents`,
    cfg.token,
  );
  let agents: ProjectAgent[] = [];
  if (agentsRes.ok) {
    agents = agentsRes.data?.agents ?? agentsRes.data?.data ?? [];
    await writeJson(path.join(outDir, 'agents.json'), agentsRes.data);
    const ablDir = path.join(outDir, 'abl');
    await fs.mkdir(ablDir, { recursive: true });
    const compDir = path.join(outDir, 'compile');
    await fs.mkdir(compDir, { recursive: true });
    for (const a of agents) {
      const dsl = a.dslContent ?? a.ablContent;
      if (dsl) {
        await fs.writeFile(path.join(ablDir, `${a.name}.abl`), dsl, 'utf8');
      }
      const diagnostics = a.dslDiagnostics ?? a.compileResult ?? a.warnings ?? a.errors;
      if (diagnostics) {
        await writeJson(path.join(compDir, `${a.name}.json`), {
          name: a.name,
          dslValidationStatus: a.dslValidationStatus,
          dslDiagnostics: a.dslDiagnostics,
          compileResult: a.compileResult,
          warnings: a.warnings,
          errors: a.errors,
        });
      }
    }
  } else {
    await writeJson(path.join(outDir, 'agents.error.json'), agentsRes);
  }

  return { ...out, agents };
}

export async function runScenario(scenario: Scenario, cfg: Config): Promise<RunResult> {
  const t0 = Date.now();
  const runSuffix =
    path
      .basename(cfg.outputDir)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-8) || Date.now().toString(36).slice(-6);
  const scenarioForRun: Scenario = {
    ...scenario,
    projectName: `${scenario.projectName} ${runSuffix}`,
  };
  const outDir = path.join(cfg.outputDir, scenario.id);
  await fs.mkdir(outDir, { recursive: true });

  const eventsFile = path.join(outDir, 'events.ndjson');
  await fs.writeFile(eventsFile, '', 'utf8');
  const errorsFile = path.join(outDir, 'errors.json');
  const errors: { stage: string; reason: string; timestamp: string }[] = [];

  const phaseTimings: Record<string, number> = {};
  const phaseStartedAt: Record<string, number> = { INTERVIEW: t0 };
  const toolCallCounts: Record<string, number> = {};
  const buildEventCounts: Record<string, number> = {};
  const buildAgents = new Map<string, BuildAgentTelemetry>();
  let reconciledSummary: unknown;
  let createdProjectIdFromEvent: string | undefined;
  const interactiveQueue: InteractiveToolEvent[] = [];
  const turnHistory: { tool: string; question: string | undefined }[] = [];
  let lastPhase = 'INTERVIEW';

  const onEvent = async (event: SSEEvent): Promise<void> => {
    const observedAt = Date.now();
    const enrichedEvent = {
      ...event,
      capturedAt: new Date(observedAt).toISOString(),
      capturedOffsetMs: observedAt - t0,
    };
    await appendNdjson(eventsFile, enrichedEvent);
    applyBudgetEvent(cfg.budget, event);
    if (event.type.startsWith('build_') || event.type === 'compile_result') {
      buildEventCounts[event.type] = (buildEventCounts[event.type] ?? 0) + 1;
      const agent = (event as { agent?: string }).agent;
      if (agent) {
        const current =
          buildAgents.get(agent) ??
          ({
            agent,
            firstEventAtMs: observedAt,
            lastEventAtMs: observedAt,
            durationMs: 0,
            stageCounts: {},
            stages: [],
            warningCount: 0,
            errorCount: 0,
            diagnosticCount: 0,
          } satisfies BuildAgentTelemetry);
        current.lastEventAtMs = observedAt;
        current.durationMs = current.lastEventAtMs - current.firstEventAtMs;

        if (event.type === 'build_agent_start') {
          current.mode = (event as { mode?: string }).mode;
          current.role = (event as { role?: string }).role;
          current.status = 'started';
        } else if (event.type === 'build_agent_stage') {
          const stage = (event as { stage?: string }).stage ?? 'unknown';
          current.stageCounts[stage] = (current.stageCounts[stage] ?? 0) + 1;
          current.stages.push({
            stage,
            detail: (event as { detail?: string }).detail,
            offsetMs: observedAt - t0,
          });
          current.status = stage;
        } else if (event.type === 'compile_result') {
          const status = (event as { status?: string }).status ?? 'unknown';
          current.status = status === 'pass' ? 'compiled' : 'compile_failed';
          current.warningCount += Array.isArray((event as { warnings?: unknown[] }).warnings)
            ? ((event as { warnings?: unknown[] }).warnings ?? []).length
            : 0;
          current.errorCount += Array.isArray((event as { errors?: unknown[] }).errors)
            ? ((event as { errors?: unknown[] }).errors ?? []).length
            : status === 'fail'
              ? 1
              : 0;
        } else if (event.type === 'build_agent_validated') {
          const warnings = (event as { warnings?: unknown[] }).warnings ?? [];
          current.warningCount += Array.isArray(warnings) ? warnings.length : 0;
          current.status = current.warningCount > 0 ? 'warning' : 'validated';
          current.toolCount = (event as { toolCount?: number }).toolCount;
          current.handoffCount = (event as { handoffCount?: number }).handoffCount;
        } else if (event.type === 'build_agent_error') {
          current.status = 'error';
          current.errorCount += 1;
        } else if (event.type === 'build_agent_diagnostics') {
          const summary = (event as { summary?: { total?: number } }).summary;
          current.diagnosticCount += summary?.total ?? 0;
        }

        buildAgents.set(agent, current);
      } else if (event.type === 'build_reconciled') {
        reconciledSummary = (event as { summary?: unknown }).summary;
      }
    }
    if (event.type === 'phase_transition') {
      const from = (event as { from?: string }).from ?? lastPhase;
      const to = (event as { to?: string }).to ?? lastPhase;
      const now = Date.now();
      phaseTimings[from] = (phaseTimings[from] ?? 0) + (now - (phaseStartedAt[from] ?? now));
      phaseStartedAt[to] = now;
      lastPhase = to;
    }
    if (event.type === 'interactive_tool') {
      interactiveQueue.push(event as unknown as InteractiveToolEvent);
    } else if (event.type === 'tool_call') {
      // Legacy v1-style tool_call events carry widget-style ask_user/collect_file
      // calls under `toolName` + `input`. Normalize to InteractiveToolEvent shape
      // so the auto-reply policy sees a uniform payload.
      const toolName = (event as { toolName?: string }).toolName;
      const toolCallId = (event as { toolCallId?: string }).toolCallId;
      if ((toolName === 'ask_user' || toolName === 'collect_file') && toolCallId) {
        const normalized: InteractiveToolEvent = {
          type: 'interactive_tool',
          tool: toolName,
          toolCallId,
          kind: 'tool',
          payload: ((event as { input?: Record<string, unknown> }).input ?? {}) as Record<
            string,
            unknown
          >,
        };
        interactiveQueue.push(normalized);
      }
    }
    if (event.type === 'tool_call' || event.type === 'interactive_tool') {
      const tn =
        (event as { toolName?: string; tool?: string }).toolName ??
        (event as { tool?: string }).tool;
      if (tn) toolCallCounts[tn] = (toolCallCounts[tn] ?? 0) + 1;
    }
    if (event.type === 'tool_result') {
      const toolCallId = (event as { toolCallId?: string }).toolCallId;
      const result = (event as { result?: unknown }).result;
      if (toolCallId === 'create_project' && result && typeof result === 'object') {
        const maybeProjectId = (result as { projectId?: unknown }).projectId;
        const success = (result as { success?: unknown }).success;
        if (success === true && typeof maybeProjectId === 'string' && maybeProjectId.length > 0) {
          createdProjectIdFromEvent = maybeProjectId;
        }
      }
    }
  };

  const sessionRes = await postJson<{ sessionId: string }>(
    `${cfg.studioUrl}/api/arch-ai/sessions`,
    { forceNew: true },
    cfg.token,
  );
  if (!sessionRes.ok || !sessionRes.data?.sessionId) {
    await writeJson(errorsFile, [
      { stage: 'session_create', reason: sessionRes.text ?? 'unknown', timestamp: nowIso() },
    ]);
    return {
      scenarioId: scenario.id,
      status: 'failed',
      failureStage: 'session_create',
      failureReason: sessionRes.text,
      durationMs: Date.now() - t0,
      phaseTimings,
      toolCallCounts,
      errorCount: 1,
    };
  }
  const sessionId = sessionRes.data.sessionId;

  const sendAndDrive = async (body: {
    sessionId: string;
    type: 'message' | 'tool_answer' | 'create';
    [k: string]: unknown;
  }): Promise<StreamSummary> => {
    let last = await streamMessage(cfg, body, onEvent);
    if (body.type === 'create') {
      return last;
    }
    for (const delayMs of TRANSIENT_STREAM_RETRY_DELAYS_MS) {
      if (!isTransientProviderError(last)) break;
      errors.push({
        stage: `stream_retry:${String(body.type)}`,
        reason: last.errorMessage ?? last.endedReason,
        timestamp: nowIso(),
      });
      await sleep(delayMs);
      last = await streamMessage(cfg, body, onEvent);
    }
    return last;
  };

  const driveTurnLoop = async (): Promise<StreamSummary['endedReason']> => {
    let lastReason: StreamSummary['endedReason'] = 'eof';
    let consecutiveSkips = 0;
    while (true) {
      const next = interactiveQueue.shift();
      if (!next) {
        const sessionDetail = await getJson<SessionDetail>(
          `${cfg.studioUrl}/api/arch-ai/sessions/${sessionId}`,
          cfg.token,
        );
        if (!sessionDetail.ok || !sessionDetail.data?.session) break;
        const phase = (sessionDetail.data.session.metadata.phase as string | undefined) ?? '?';
        const pending = (
          sessionDetail.data.session.metadata.pendingInteraction as { kind?: string } | undefined
        )?.kind;
        if (phase === 'CREATE' && !pending) {
          const creatRes = await sendAndDrive({ sessionId, type: 'create' });
          lastReason = creatRes.endedReason;
          if (creatRes.endedReason === 'error' || creatRes.endedReason === 'timeout') {
            errors.push({
              stage: 'create_project',
              reason: creatRes.errorMessage ?? creatRes.endedReason,
              timestamp: nowIso(),
            });
            return creatRes.endedReason;
          }
          break;
        }
        if (phase === 'BLUEPRINT' && !pending) {
          const r = await sendAndDrive({
            sessionId,
            type: 'message',
            text: 'Generate the draft topology now.',
          });
          lastReason = r.endedReason;
          if (r.endedReason === 'error' || r.endedReason === 'timeout') {
            errors.push({
              stage: 'blueprint_nudge',
              reason: r.errorMessage ?? r.endedReason,
              timestamp: nowIso(),
            });
            return r.endedReason;
          }
          continue;
        }
        if (phase === 'INTERVIEW' && !pending) {
          const r = await sendAndDrive({
            sessionId,
            type: 'message',
            text: 'Proceed to design the architecture.',
          });
          lastReason = r.endedReason;
          if (r.endedReason === 'error' || r.endedReason === 'timeout') {
            errors.push({
              stage: 'interview_proceed',
              reason: r.errorMessage ?? r.endedReason,
              timestamp: nowIso(),
            });
            return r.endedReason;
          }
          continue;
        }
        break;
      }

      const decision = decideReply(next, scenarioForRun, turnHistory);
      const q = (next.payload as { question?: string }).question;
      turnHistory.push({ tool: next.tool, question: q });
      if (decision.kind === 'stop') {
        errors.push({
          stage: `widget_decide:${next.tool}`,
          reason: decision.reason,
          timestamp: nowIso(),
        });
        return 'error';
      }
      if (decision.kind === 'skip') {
        consecutiveSkips += 1;
        if (consecutiveSkips > 3) {
          errors.push({
            stage: `widget_skip_loop`,
            reason: 'too many consecutive skips',
            timestamp: nowIso(),
          });
          return 'error';
        }
        continue;
      }
      consecutiveSkips = 0;

      const r = await sendAndDrive({
        sessionId,
        type: 'tool_answer',
        toolCallId: decision.toolCallId,
        answer: decision.answer,
      });
      lastReason = r.endedReason;
      if (r.endedReason === 'error' || r.endedReason === 'timeout') {
        errors.push({
          stage: `tool_answer:${next.tool}`,
          reason: r.errorMessage ?? r.endedReason,
          timestamp: nowIso(),
        });
        return r.endedReason;
      }
    }
    return lastReason;
  };

  const seedRes = await sendAndDrive({
    sessionId,
    type: 'message',
    text: `${scenario.seedMessage}\n\nUse this exact project name unless I change it later: ${scenarioForRun.projectName}.`,
  });
  if (seedRes.endedReason === 'error' || seedRes.endedReason === 'timeout') {
    errors.push({
      stage: 'seed_message',
      reason: seedRes.errorMessage ?? seedRes.endedReason,
      timestamp: nowIso(),
    });
    await writeJson(errorsFile, errors);
    return {
      scenarioId: scenario.id,
      status: 'failed',
      failureStage: 'seed_message',
      failureReason: seedRes.errorMessage,
      sessionId,
      durationMs: Date.now() - t0,
      phaseTimings,
      toolCallCounts,
      errorCount: errors.length,
    };
  }

  await driveTurnLoop();

  const sessionFinal = await getJson<SessionDetail>(
    `${cfg.studioUrl}/api/arch-ai/sessions/${sessionId}`,
    cfg.token,
  );
  if (sessionFinal.ok) {
    await writeJson(path.join(outDir, 'session.json'), sessionFinal.data);
  } else {
    errors.push({
      stage: 'session_final_fetch',
      reason: sessionFinal.text ?? `HTTP ${sessionFinal.status}`,
      timestamp: nowIso(),
    });
  }

  const projectId =
    ((sessionFinal.data?.session?.metadata?.projectId as string | undefined) ?? undefined) ||
    createdProjectIdFromEvent;

  const topology = sessionFinal.data?.session?.metadata?.topology;
  if (topology) await writeJson(path.join(outDir, 'topology.json'), topology);

  let agentCount: number | undefined;
  let projectSlug: string | undefined;
  if (projectId) {
    const arts = await fetchProjectArtifacts(cfg, projectId, outDir);
    agentCount = arts.agents.length;
    projectSlug = arts.project?.project?.slug;
  } else {
    errors.push({
      stage: 'no_project_created',
      reason: 'session ended without projectId in metadata or create_project result',
      timestamp: nowIso(),
    });
  }

  // ─── Always archive the session at end-of-scenario ─────────────────────
  // POST /api/arch-ai/sessions is "get-or-create": a non-archived session
  // within the stuck-recovery threshold is reused by the next scenario.
  // Without explicit archive, a hung scenario poisons subsequent ones
  // (round-2 cascade: s27 timeout → s28/s29/s30 SESSION_BUSY). The project
  // and agents persist independently in MongoDB — only the session is
  // archived. Best-effort; archive failure doesn't affect the scenario
  // result we just collected.
  try {
    await postJson<{ ok: boolean }>(
      `${cfg.studioUrl}/api/arch-ai/sessions/${sessionId}/archive`,
      {},
      cfg.token,
    );
  } catch (archiveErr) {
    errors.push({
      stage: 'session_archive',
      reason: archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
      timestamp: nowIso(),
    });
  }

  const tEnd = Date.now();
  phaseTimings[lastPhase] =
    (phaseTimings[lastPhase] ?? 0) + (tEnd - (phaseStartedAt[lastPhase] ?? tEnd));

  await writeJson(errorsFile, errors);

  const buildAgentRows = [...buildAgents.values()].sort((a, b) => b.durationMs - a.durationMs);
  const buildTelemetry: BuildTelemetry = {
    agentCount: buildAgentRows.length,
    buildEventCount: Object.values(buildEventCounts).reduce((sum, count) => sum + count, 0),
    slowestAgent: buildAgentRows[0]?.agent,
    slowestAgentMs: buildAgentRows[0]?.durationMs,
    reconciledSummary,
    eventCounts: buildEventCounts,
    agents: buildAgentRows,
  };
  await writeJson(path.join(outDir, 'build-telemetry.json'), buildTelemetry);

  const final: RunResult = {
    scenarioId: scenario.id,
    status: projectId ? 'completed' : 'failed',
    failureStage: projectId ? undefined : 'no_project',
    sessionId,
    projectId,
    projectSlug,
    durationMs: tEnd - t0,
    phaseTimings,
    toolCallCounts,
    errorCount: errors.length,
    agentCount,
    tokenCount: cfg.budget?.tokens,
    estimatedCostUsd: cfg.budget?.costUsd,
    buildTelemetry: {
      agentCount: buildTelemetry.agentCount,
      buildEventCount: buildTelemetry.buildEventCount,
      slowestAgent: buildTelemetry.slowestAgent,
      slowestAgentMs: buildTelemetry.slowestAgentMs,
      reconciledSummary: buildTelemetry.reconciledSummary,
    },
  };
  await writeJson(path.join(outDir, 'final.json'), final);
  return final;
}

function applyBudgetEvent(budget: EvalBudget | undefined, event: SSEEvent): void {
  if (!budget) {
    return;
  }

  const completion = (event as { completion?: unknown }).completion;
  if (!completion || typeof completion !== 'object') {
    return;
  }

  const usage = (completion as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') {
    return;
  }

  const totalTokens = Number((usage as { totalTokens?: unknown }).totalTokens ?? 0);
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    budget.tokens += totalTokens;
  }

  const explicitCost = Number(
    (completion as { estimatedCost?: unknown }).estimatedCost ??
      (usage as { estimatedCost?: unknown }).estimatedCost,
  );
  if (Number.isFinite(explicitCost) && explicitCost > 0) {
    budget.costUsd += explicitCost;
  } else if (Number.isFinite(totalTokens) && totalTokens > 0) {
    budget.costUsd += totalTokens * FALLBACK_USD_PER_TOKEN;
  }

  if (budget.maxTokens !== undefined && budget.tokens > budget.maxTokens) {
    budget.exceeded = `token budget exceeded (${budget.tokens}/${budget.maxTokens})`;
    throw new Error(budget.exceeded);
  }
  if (budget.maxCostUsd !== undefined && budget.costUsd > budget.maxCostUsd) {
    budget.exceeded = `cost budget exceeded ($${budget.costUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)})`;
    throw new Error(budget.exceeded);
  }
}
