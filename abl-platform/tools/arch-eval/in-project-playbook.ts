/**
 * IN_PROJECT modification playbook — runs a fixed set of editing turns against
 * an existing project to evaluate the in-project specialist's reasoning,
 * proposal accuracy, and tool-use quality.
 *
 * For each project, executes:
 *   1. read context — list agents, ask which has the most warnings
 *   2. propose-only — request a modification proposal (no apply)
 *   3. tool-add — propose adding a tool to one agent
 *   4. fix-warning — ask architect to address one health warning
 *   5. handoff-edit — ask architect to add a handoff edge
 *   6. health-recheck — ask for current health summary
 *
 * For each turn, captures:
 *   - turn id, request text, full SSE event log
 *   - tool-call counts and tool-call inputs
 *   - whether a propose_modification or apply_modification fired
 *   - a 0-5 reasoning quality score (heuristic — flagged as such)
 *
 * Usage:
 *   pnpm exec tsx tools/arch-eval/in-project-playbook.ts \
 *     --run-dir docs/testing/arch-eval/<run-id> \
 *     --project-ids <id1>,<id2>,<id3>
 *
 * Or use --pick best,median,worst to auto-select from scoring.json.
 *
 * To run directly against current local Studio projects:
 *   pnpm arch:in-project:battle \
 *     --run-dir docs/testing/arch-eval/local-in-project-<date> \
 *     --discover-local-projects --max-projects 6
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { decideReply, type InteractiveToolEvent } from './auto-reply.js';
import type { Scenario } from './scenarios.js';

const execFileAsync = promisify(execFile);

interface CliArgs {
  runDir: string;
  studioUrl: string;
  email: string;
  projectIds: string[];
  pick?: 'best' | 'median' | 'worst' | 'all';
  skipPm2Logs: boolean;
  discoverLocalProjects: boolean;
  maxProjects: number;
}

interface PlaybookTurn {
  name: string;
  text: string;
  rubric: string;
}

const PLAYBOOK: PlaybookTurn[] = [
  {
    name: 'context_read',
    text: 'List the agents in this project, summarize each one in one sentence, and tell me which agent has the most warnings or compile issues. Use platform_context and diagnose_project as needed.',
    rubric:
      'Lists all agents accurately; correctly identifies highest-warning agent; cites concrete diagnostic output.',
  },
  {
    name: 'propose_only',
    text: 'Propose a modification to the entry-point agent that improves its routing logic — for example, adding sentiment-aware escalation or a clearer catch-all handoff. Show the proposal as a diff but do NOT apply it. Explain trade-offs.',
    rubric:
      'Calls propose_modification with concrete diff; explains the change in terms of ABL constructs (HANDOFF/WHEN/COMPLETE); does NOT call apply_modification.',
  },
  {
    name: 'tool_add',
    text: 'Add a TOOLS section entry called "lookup_user_history" that takes a user_id and returns past_orders + preferences, to whichever specialist would benefit most. Show the proposed diff. Do not create the actual ProjectTool record yet — just the agent-side TOOLS signature.',
    rubric:
      'Selects a sensible specialist (recommendation/order/triage); writes a syntactically correct TOOLS signature; warns about missing ProjectTool implementation.',
  },
  {
    name: 'fix_warning',
    text: 'Pick the most severe project warning from the health report and propose a precise fix. Use diagnose_project + propose_modification. Walk me through how the fix addresses the warning.',
    rubric:
      'Cites a specific warning code or label; proposed fix matches the warning category; uses propose_modification (not direct write).',
  },
  {
    name: 'handoff_edit',
    text: 'Propose a HANDOFF rule from the entry-point agent to the human-escalation agent triggered when sentiment is highly_negative OR when the user explicitly asks for a human. Show the diff and validate the WHEN expression syntax.',
    rubric:
      'Writes a valid CEL/ABL WHEN expression; uses correct HANDOFF block formatting (TO, WHEN, RETURN); confirms expression compiles via dry_run_compile or compile_abl.',
  },
  {
    name: 'health_recheck',
    text: 'Run a project health check and tell me what the riskiest remaining issue is now (after my proposed-but-not-applied changes). Be concrete: agent name, construct, and the specific test that would catch it.',
    rubric:
      'Calls health_check or diagnose_project; cites specific agent + construct; proposes a concrete test scenario.',
  },
  {
    name: 'runtime_context_validation',
    text: 'Validate the latest proposed or generated agent/tool change against the actual runtime project context before anything is applied. Check the full project graph, current agents, topology, tool implementations, auth profiles, variables, model configuration inheritance, project-aware compile/AgentIR readiness, diagnostics, and feasibility. Use read_agent/read_topology, platform_context, tools_ops, auth_ops/variable_ops/configure_model as relevant, dry_run_compile or compile_abl for project-aware compile evidence, validate_agent for diagnostics, diagnose_project or health_check, and run_feasibility_check. Do not apply changes. If any readiness evidence is missing, say exactly what is missing.',
    rubric:
      'Runs runtime-context validation tools, distinguishes missing evidence from passed checks, and does not mark the proposal ready without compile/diagnostic/tool/model evidence.',
  },
  {
    name: 'runtime_smoke',
    text: 'Run one non-destructive runtime smoke validation for the most relevant changed or entry agent. Prefer run_simulation with scripted user turns and mocked tool responses when available; otherwise use testing_ops run_test. Report whether the generated/proposed behavior works with neighboring agents and project configuration. Do not apply changes.',
    rubric:
      'Calls run_simulation or testing_ops run_test, captures pass/fail evidence, and relates the smoke result back to the proposal and topology.',
  },
];

type GateStatus = 'pass' | 'fail' | 'missing';

interface RuntimeContextGate {
  status: GateStatus;
  evidence: string[];
}

interface RuntimeContextScore {
  agentIRResolved: RuntimeContextGate;
  projectCompilePassed: RuntimeContextGate;
  topologyConsistent: RuntimeContextGate;
  toolBindingsResolved: RuntimeContextGate;
  authVariablesResolved: RuntimeContextGate;
  modelConfigResolved: RuntimeContextGate;
  diagnosticsCleanOrExplained: RuntimeContextGate;
  runtimeFlowSmokePassed: RuntimeContextGate;
  score: number;
  passed: number;
  failed: number;
  missing: number;
  ready: boolean;
  blockers: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    studioUrl: 'http://localhost:5173',
    email: 'test@example.com',
    projectIds: [],
    skipPm2Logs: false,
    discoverLocalProjects: false,
    maxProjects: 6,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-dir') out.runDir = argv[++i];
    else if (a === '--studio') out.studioUrl = argv[++i];
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--project-ids') out.projectIds = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--pick') {
      const v = argv[++i] as 'best' | 'median' | 'worst' | 'all';
      out.pick = v;
    } else if (a === '--skip-pm2-logs') {
      out.skipPm2Logs = true;
    } else if (a === '--discover-local-projects') {
      out.discoverLocalProjects = true;
    } else if (a === '--max-projects') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.maxProjects = Math.floor(parsed);
      }
    }
  }
  if (!out.runDir) {
    process.stderr.write(
      'Required: --run-dir <path>. Optionally --pick best,median,worst or --project-ids id,id,id\n',
    );
    process.exit(1);
  }
  return out as CliArgs;
}

async function devLogin(studio: string, email: string): Promise<string> {
  const res = await fetch(`${studio}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'Arch InProject Bot' }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status}`);
  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) throw new Error('no accessToken');
  return data.accessToken;
}

interface SSEEvent {
  type: string;
  [k: string]: unknown;
}

interface TurnRecord {
  turnName: string;
  request: string;
  durationMs: number;
  events: SSEEvent[];
  toolCalls: { toolName: string; toolCallId: string; input?: unknown; isError?: boolean }[];
  proposedModification: boolean;
  appliedModification: boolean;
  errorEvents: { code?: string; message?: string }[];
  rubric: string;
  reasoningScore: number;
  scoreNotes: string[];
  runtimeContextScore: RuntimeContextScore;
}

interface SessionDetail {
  success?: boolean;
  session?: {
    id: string;
    state: string;
    metadata: Record<string, unknown>;
  };
}

async function postJson<T>(
  url: string,
  body: unknown,
  token: string,
): Promise<{ ok: boolean; status: number; data?: T; text?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return { ok: false, status: res.status, text };
  }
  return { ok: true, status: res.status, data: (await res.json()) as T };
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
  return { ok: true, status: res.status, data: (await res.json()) as T };
}

interface StreamOpts {
  studioUrl: string;
  token: string;
  body: unknown;
  onEvent: (event: SSEEvent) => Promise<void>;
}

async function streamMessage(opts: StreamOpts): Promise<{ events: SSEEvent[]; error?: string }> {
  const events: SSEEvent[] = [];
  let firstError: string | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
  try {
    const res = await fetch(`${opts.studioUrl}/api/arch-ai/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      return { events, error: `HTTP ${res.status}: ${text}` };
    }
    const queue: SSEEvent[] = [];
    const parser = createParser({
      onEvent(msg: EventSourceMessage) {
        if (!msg.data) return;
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const ev: SSEEvent = { type: msg.event ?? 'unknown', ...payload };
        events.push(ev);
        queue.push(ev);
        if (ev.type === 'error') {
          const e = ev.error as { message?: string } | undefined;
          if (!firstError) firstError = e?.message ?? 'error';
        }
      },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        await opts.onEvent(next);
      }
    }
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      await opts.onEvent(next);
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) {
      firstError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
  }
  return { events, error: firstError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolInputAction(input: unknown): string | undefined {
  return isRecord(input) && typeof input.action === 'string' ? input.action : undefined;
}

function eventResultPayload(event: SSEEvent): unknown {
  if ('result' in event) return event.result;
  if (isRecord(event.data) && 'result' in event.data) return event.data.result;
  if (isRecord(event.output)) return event.output;
  return event.data ?? event;
}

function collectResultPayloads(events: SSEEvent[], toolNames: Set<string>): unknown[] {
  return events
    .filter((event) => event.type === 'tool_result')
    .filter((event) => {
      const toolName =
        typeof event.toolName === 'string'
          ? event.toolName
          : isRecord(event.data) && typeof event.data.toolName === 'string'
            ? event.data.toolName
            : '';
      return toolNames.has(toolName);
    })
    .map(eventResultPayload);
}

function resultHasFailure(value: unknown): boolean {
  if (isRecord(value)) {
    if (value.success === false || value.status === 'fail' || value.passed === false) return true;
    if (isRecord(value.validation) && value.validation.valid === false) return true;
    if (Array.isArray(value.errors) && value.errors.length > 0) return true;
    if (isRecord(value.error)) return true;
    return Object.values(value).some(resultHasFailure);
  }
  if (Array.isArray(value)) return value.some(resultHasFailure);
  return false;
}

function resultHasPass(value: unknown): boolean {
  if (isRecord(value)) {
    if (
      value.success === true ||
      value.status === 'pass' ||
      value.passed === true ||
      value.compiledWithProjectContext === true
    ) {
      return true;
    }
    if (isRecord(value.validation) && value.validation.valid === true) return true;
    if (Array.isArray(value.agentsInScope) && value.agentsInScope.length > 0) return true;
    return Object.values(value).some(resultHasPass);
  }
  if (Array.isArray(value)) return value.some(resultHasPass);
  return false;
}

function gate(
  passed: boolean,
  failed: boolean,
  missingEvidence: string,
  passEvidence: string[],
  failEvidence: string[] = [],
): RuntimeContextGate {
  if (failed)
    return { status: 'fail', evidence: failEvidence.length ? failEvidence : passEvidence };
  if (passed) return { status: 'pass', evidence: passEvidence };
  return { status: 'missing', evidence: [missingEvidence] };
}

function buildRuntimeContextScore(
  turnName: string,
  toolCalls: TurnRecord['toolCalls'],
  events: SSEEvent[],
): RuntimeContextScore {
  const names = new Set(toolCalls.map((call) => call.toolName));

  const compileTools = new Set(['compile_abl', 'dry_run_compile']);
  const compileResults = collectResultPayloads(events, compileTools);
  const compileFailed =
    toolCalls.some((call) => compileTools.has(call.toolName) && call.isError) ||
    compileResults.some(resultHasFailure);
  const compilePassed = compileResults.some(resultHasPass);
  const compileEvidence = [
    ...toolCalls
      .filter((call) => compileTools.has(call.toolName))
      .map((call) => `${call.toolName}${call.isError ? ' failed' : ''}`),
    ...compileResults.slice(0, 2).map((result) => compactJson(result).slice(0, 500)),
  ];

  const topologyRead = names.has('read_topology');
  const topologyEvidence = toolCalls
    .filter((call) => call.toolName === 'read_topology' || call.toolName.startsWith('find_'))
    .map((call) => call.toolName);
  const topologyFailed = toolCalls.some(
    (call) =>
      (call.toolName === 'read_topology' || call.toolName.startsWith('find_')) && call.isError,
  );

  const toolContextCalls = toolCalls.filter((call) => {
    if (call.toolName === 'tools_ops') return true;
    if (call.toolName === 'platform_context') {
      const action = toolInputAction(call.input);
      return action === 'list_tools' || compactJson(call.input).includes('list_tools');
    }
    if (call.toolName === 'run_feasibility_check') {
      return compactJson(call.input).includes('tool-binding');
    }
    return false;
  });
  const toolResults = collectResultPayloads(
    events,
    new Set(['tools_ops', 'platform_context', 'run_feasibility_check']),
  );
  const toolFailed =
    toolContextCalls.some((call) => call.isError) ||
    toolResults.some((result) => {
      const text = compactJson(result).toLowerCase();
      return resultHasFailure(result) || text.includes('unresolved');
    });

  const authVariableCalls = toolCalls.filter((call) => {
    if (call.toolName === 'auth_ops' || call.toolName === 'variable_ops') return true;
    if (call.toolName === 'platform_context') {
      const text = compactJson(call.input);
      return text.includes('list_auth_profiles') || text.includes('variable');
    }
    return false;
  });
  const authVariableResults = collectResultPayloads(
    events,
    new Set(['auth_ops', 'variable_ops', 'platform_context']),
  );
  const authVariableFailed =
    authVariableCalls.some((call) => call.isError) ||
    authVariableResults.some((result) => {
      const text = compactJson(result).toLowerCase();
      return resultHasFailure(result) || text.includes('missing secret');
    });

  const modelCalls = toolCalls.filter((call) => {
    if (call.toolName === 'configure_model' || call.toolName === 'recommend_model') return true;
    if (call.toolName === 'project_config') {
      return toolInputAction(call.input) === 'get_settings';
    }
    return false;
  });
  const modelResults = collectResultPayloads(
    events,
    new Set(['configure_model', 'recommend_model', 'project_config', 'health_check']),
  );
  const modelFailed =
    modelCalls.some((call) => call.isError) ||
    modelResults.some((result) => {
      const text = compactJson(result).toLowerCase();
      return resultHasFailure(result) && text.includes('model');
    });
  const healthModelEvidence = modelResults.some((result) =>
    compactJson(result).toLowerCase().includes('modelconfig'),
  );

  const diagnosticTools = new Set(['health_check', 'diagnose_project', 'validate_agent']);
  const diagnosticResults = collectResultPayloads(events, diagnosticTools);
  const diagnosticsFailed =
    toolCalls.some((call) => diagnosticTools.has(call.toolName) && call.isError) ||
    diagnosticResults.some((result) => {
      const text = compactJson(result).toLowerCase();
      return resultHasFailure(result) && !text.includes('warnings');
    });
  const diagnosticsPassed = diagnosticResults.length > 0 && !diagnosticsFailed;

  const smokeTools = new Set(['run_simulation', 'testing_ops']);
  const smokeCalls = toolCalls.filter((call) => {
    if (call.toolName === 'run_simulation') return true;
    return call.toolName === 'testing_ops' && toolInputAction(call.input) === 'run_test';
  });
  const smokeResults = collectResultPayloads(events, smokeTools);
  const smokeFailed =
    smokeCalls.some((call) => call.isError) || smokeResults.some(resultHasFailure);
  const smokePassed = smokeResults.some(resultHasPass) && !smokeFailed;

  const checks: Omit<
    RuntimeContextScore,
    'score' | 'passed' | 'failed' | 'missing' | 'ready' | 'blockers'
  > = {
    agentIRResolved: gate(
      compilePassed &&
        compileResults.some((result) => compactJson(result).includes('agentsInScope')),
      compileFailed,
      'No project-context compile evidence proving AgentIR/project scope resolution.',
      compileEvidence,
    ),
    projectCompilePassed: gate(
      compilePassed,
      compileFailed,
      'No compile_abl or dry_run_compile project compile evidence.',
      compileEvidence,
    ),
    topologyConsistent: gate(
      topologyRead,
      topologyFailed,
      'No read_topology evidence for cross-agent topology validation.',
      topologyEvidence,
    ),
    toolBindingsResolved: gate(
      toolContextCalls.length > 0 && !toolFailed,
      toolFailed,
      'No tools_ops/platform_context list_tools/tool-binding feasibility evidence.',
      toolContextCalls.map((call) => `${call.toolName}:${compactJson(call.input).slice(0, 200)}`),
    ),
    authVariablesResolved: gate(
      authVariableCalls.length > 0 && !authVariableFailed,
      authVariableFailed,
      'No auth_ops/variable_ops/platform_context auth-variable evidence.',
      authVariableCalls.map((call) => `${call.toolName}:${compactJson(call.input).slice(0, 200)}`),
    ),
    modelConfigResolved: gate(
      (modelCalls.length > 0 || healthModelEvidence) && !modelFailed,
      modelFailed,
      'No configure_model/recommend_model/project settings/modelConfig evidence.',
      modelCalls.map((call) => `${call.toolName}:${compactJson(call.input).slice(0, 200)}`),
    ),
    diagnosticsCleanOrExplained: gate(
      diagnosticsPassed,
      diagnosticsFailed,
      'No health_check, diagnose_project, or validate_agent diagnostic evidence.',
      [
        ...toolCalls
          .filter((call) => diagnosticTools.has(call.toolName))
          .map((call) => call.toolName),
        ...diagnosticResults.slice(0, 1).map((result) => compactJson(result).slice(0, 500)),
      ],
    ),
    runtimeFlowSmokePassed: gate(
      smokePassed,
      smokeFailed,
      'No run_simulation or testing_ops run_test runtime smoke evidence.',
      smokeCalls.map((call) => `${call.toolName}:${compactJson(call.input).slice(0, 200)}`),
    ),
  };

  const gateEntries = Object.entries(checks) as Array<[keyof typeof checks, RuntimeContextGate]>;
  const passed = gateEntries.filter(([, value]) => value.status === 'pass').length;
  const failed = gateEntries.filter(([, value]) => value.status === 'fail').length;
  const missing = gateEntries.filter(([, value]) => value.status === 'missing').length;
  const blockers = gateEntries
    .filter(([, value]) => value.status !== 'pass')
    .map(([name, value]) => `${name}: ${value.evidence[0] ?? value.status}`);
  const score = Math.round((passed / gateEntries.length) * 100);

  return {
    ...checks,
    score,
    passed,
    failed,
    missing,
    ready: failed === 0 && missing === 0,
    blockers,
  };
}

function combineGate(gates: RuntimeContextGate[]): RuntimeContextGate {
  const failed = gates.filter((gateValue) => gateValue.status === 'fail');
  if (failed.length > 0) {
    return {
      status: 'fail',
      evidence: failed.flatMap((gateValue) => gateValue.evidence).slice(0, 6),
    };
  }
  const passed = gates.filter((gateValue) => gateValue.status === 'pass');
  if (passed.length > 0) {
    return {
      status: 'pass',
      evidence: passed.flatMap((gateValue) => gateValue.evidence).slice(0, 6),
    };
  }
  return {
    status: 'missing',
    evidence: gates.flatMap((gateValue) => gateValue.evidence).slice(0, 6),
  };
}

function combineRuntimeContextScores(turns: TurnRecord[]): RuntimeContextScore {
  const keys: Array<
    keyof Omit<
      RuntimeContextScore,
      'score' | 'passed' | 'failed' | 'missing' | 'ready' | 'blockers'
    >
  > = [
    'agentIRResolved',
    'projectCompilePassed',
    'topologyConsistent',
    'toolBindingsResolved',
    'authVariablesResolved',
    'modelConfigResolved',
    'diagnosticsCleanOrExplained',
    'runtimeFlowSmokePassed',
  ];
  const combined = Object.fromEntries(
    keys.map((key) => [key, combineGate(turns.map((turn) => turn.runtimeContextScore[key]))]),
  ) as Omit<RuntimeContextScore, 'score' | 'passed' | 'failed' | 'missing' | 'ready' | 'blockers'>;
  const entries = keys.map((key) => [key, combined[key]] as const);
  const passed = entries.filter(([, value]) => value.status === 'pass').length;
  const failed = entries.filter(([, value]) => value.status === 'fail').length;
  const missing = entries.filter(([, value]) => value.status === 'missing').length;
  const blockers = entries
    .filter(([, value]) => value.status !== 'pass')
    .map(([name, value]) => `${name}: ${value.evidence[0] ?? value.status}`);
  return {
    ...combined,
    score: Math.round((passed / keys.length) * 100),
    passed,
    failed,
    missing,
    ready: failed === 0 && missing === 0,
    blockers,
  };
}

function combineFinalRuntimeValidationScores(turns: TurnRecord[]): RuntimeContextScore {
  const validationTurns = turns.filter(
    (turn) => turn.turnName === 'runtime_context_validation' || turn.turnName === 'runtime_smoke',
  );
  return combineRuntimeContextScores(validationTurns.length > 0 ? validationTurns : turns);
}

async function capturePm2Logs(lines = 120): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'pm2',
      ['logs', '--lines', String(lines), '--nostream'],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    return {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runTurn(
  studioUrl: string,
  token: string,
  sessionId: string,
  turn: PlaybookTurn,
  scenarioMeta: Scenario,
): Promise<TurnRecord> {
  const t0 = Date.now();
  const events: SSEEvent[] = [];
  const toolCalls: TurnRecord['toolCalls'] = [];
  const errorEvents: TurnRecord['errorEvents'] = [];
  let proposedModification = false;
  let appliedModification = false;

  const interactiveQueue: InteractiveToolEvent[] = [];
  const turnHistory: { tool: string; question: string | undefined }[] = [];

  const onEvent = async (event: SSEEvent): Promise<void> => {
    events.push(event);
    if (event.type === 'tool_call') {
      const toolName = (event as { toolName?: string }).toolName ?? '';
      const toolCallId = (event as { toolCallId?: string }).toolCallId ?? '';
      toolCalls.push({
        toolName,
        toolCallId,
        input: (event as { input?: unknown }).input,
      });
      if (toolName === 'propose_modification') proposedModification = true;
      if (toolName === 'apply_modification') appliedModification = true;
      if ((toolName === 'ask_user' || toolName === 'collect_file') && toolCallId) {
        interactiveQueue.push({
          type: 'interactive_tool',
          tool: toolName,
          toolCallId,
          kind: 'tool',
          payload: ((event as { input?: Record<string, unknown> }).input ?? {}) as Record<
            string,
            unknown
          >,
        });
      }
    } else if (event.type === 'interactive_tool') {
      interactiveQueue.push(event as unknown as InteractiveToolEvent);
    } else if (event.type === 'tool_result') {
      const toolName = (event as { toolName?: string }).toolName ?? '';
      const isError = Boolean((event as { isError?: boolean }).isError);
      const last = toolCalls.find(
        (c) => c.toolCallId === (event as { toolCallId?: string }).toolCallId,
      );
      if (last) last.isError = isError;
      if (isError) {
        errorEvents.push({ code: 'tool_error', message: `${toolName} failed` });
      }
    } else if (event.type === 'error') {
      const e = event.error as { code?: string; message?: string } | undefined;
      errorEvents.push({ code: e?.code, message: e?.message });
    }
  };

  const sendOne = async (body: {
    sessionId: string;
    type: 'message' | 'tool_answer';
    [k: string]: unknown;
  }): Promise<void> => {
    await streamMessage({ studioUrl, token, body, onEvent });
  };

  await sendOne({ sessionId, type: 'message', text: turn.text });

  // Drain widgets — limit to a few to avoid endless clarifying loops.
  let widgetTurns = 0;
  while (interactiveQueue.length > 0 && widgetTurns < 8) {
    const next = interactiveQueue.shift();
    if (!next) break;
    const decision = decideReply(next, scenarioMeta, turnHistory);
    turnHistory.push({
      tool: next.tool,
      question: (next.payload as { question?: string }).question,
    });
    if (decision.kind !== 'answer') break;
    widgetTurns += 1;
    await sendOne({
      sessionId,
      type: 'tool_answer',
      toolCallId: decision.toolCallId,
      answer: decision.answer,
    });
  }

  // Heuristic reasoning score.
  const scoreNotes: string[] = [];
  let reasoningScore = 2; // baseline
  if (
    turn.name === 'propose_only' ||
    turn.name === 'tool_add' ||
    turn.name === 'fix_warning' ||
    turn.name === 'handoff_edit'
  ) {
    if (proposedModification) {
      reasoningScore += 1.5;
      scoreNotes.push('called propose_modification');
    } else {
      scoreNotes.push('did NOT call propose_modification (expected)');
    }
    if (appliedModification && turn.name === 'propose_only') {
      reasoningScore -= 1;
      scoreNotes.push('applied unexpectedly (rubric said propose-only)');
    }
  }
  if (turn.name === 'context_read') {
    const calledPlatform = toolCalls.some((c) => c.toolName === 'platform_context');
    const calledDiag = toolCalls.some(
      (c) => c.toolName === 'diagnose_project' || c.toolName === 'health_check',
    );
    if (calledPlatform) {
      reasoningScore += 1;
      scoreNotes.push('used platform_context');
    }
    if (calledDiag) {
      reasoningScore += 1;
      scoreNotes.push('used diagnose_project/health_check');
    }
  }
  if (errorEvents.length > 0) {
    reasoningScore -= 1;
    scoreNotes.push(`${errorEvents.length} error events`);
  }
  const runtimeContextScore = buildRuntimeContextScore(turn.name, toolCalls, events);
  if (runtimeContextScore.failed > 0) {
    reasoningScore -= 0.5;
    scoreNotes.push(`${runtimeContextScore.failed} runtime-context gate(s) failed`);
  }
  if (
    (turn.name === 'runtime_context_validation' || turn.name === 'runtime_smoke') &&
    !runtimeContextScore.ready
  ) {
    reasoningScore -= 1;
    scoreNotes.push(
      `runtime-context evidence incomplete: ${runtimeContextScore.blockers.slice(0, 3).join('; ')}`,
    );
  }
  reasoningScore = Math.max(0, Math.min(5, reasoningScore));

  return {
    turnName: turn.name,
    request: turn.text,
    durationMs: Date.now() - t0,
    events,
    toolCalls,
    proposedModification,
    appliedModification,
    errorEvents,
    rubric: turn.rubric,
    reasoningScore,
    scoreNotes,
    runtimeContextScore,
  };
}

interface ProjectInfo {
  projectId: string;
  scenarioId: string;
  projectSlug?: string;
  projectName?: string;
  agentCount?: number;
  source: 'eval-run' | 'local-studio';
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function hasAgents(studioUrl: string, token: string, projectId: string): Promise<number> {
  const res = await getJson<{
    success?: boolean;
    agents?: Array<{ _id?: string; id?: string; name?: string }>;
  }>(`${studioUrl}/api/projects/${projectId}/agents`, token);
  if (!res.ok) {
    return 0;
  }
  return Array.isArray(res.data?.agents) ? res.data.agents.length : 0;
}

async function discoverLocalProjects(args: CliArgs): Promise<ProjectInfo[]> {
  const token = await devLogin(args.studioUrl, args.email);
  const res = await getJson<{
    projects?: Array<{
      id?: string;
      _id?: string;
      name?: string;
      projectName?: string;
      agentCount?: number;
    }>;
  }>(`${args.studioUrl}/api/projects`, token);
  if (!res.ok) {
    throw new Error(`local project discovery failed: HTTP ${res.status}: ${res.text ?? ''}`);
  }

  const discovered: ProjectInfo[] = [];
  for (const raw of res.data?.projects ?? []) {
    const projectId = raw.id ?? raw._id;
    if (!projectId) continue;
    const projectName = raw.name ?? raw.projectName ?? projectId;
    const knownAgentCount = typeof raw.agentCount === 'number' ? raw.agentCount : undefined;
    const agentCount =
      knownAgentCount && knownAgentCount > 0
        ? knownAgentCount
        : await hasAgents(args.studioUrl, token, projectId);
    if (agentCount <= 0) continue;
    const slug = slugify(projectName) || `project-${projectId.slice(-8)}`;
    discovered.push({
      projectId,
      projectName,
      projectSlug: slug,
      scenarioId: `local-${slug}-${projectId.slice(-6)}`,
      agentCount,
      source: 'local-studio',
    });
    if (discovered.length >= args.maxProjects) break;
  }

  if (args.projectIds.length > 0) {
    const want = new Set(args.projectIds);
    return discovered.filter((project) => want.has(project.projectId));
  }
  return discovered;
}

async function loadProjects(args: CliArgs): Promise<ProjectInfo[]> {
  if (args.discoverLocalProjects) {
    return discoverLocalProjects(args);
  }

  const summaryPath = path.join(args.runDir, 'summary.json');
  const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as Array<{
    scenarioId: string;
    projectId?: string;
    projectSlug?: string;
    status: string;
  }>;
  const completed = summary.filter((s) => s.status === 'completed' && s.projectId);

  if (args.projectIds.length > 0) {
    const want = new Set(args.projectIds);
    return completed
      .filter((s) => want.has(s.projectId ?? ''))
      .map((s) => ({
        projectId: s.projectId as string,
        scenarioId: s.scenarioId,
        projectSlug: s.projectSlug,
        source: 'eval-run',
      }));
  }

  if (args.pick === 'all') {
    return completed.map((s) => ({
      projectId: s.projectId as string,
      scenarioId: s.scenarioId,
      projectSlug: s.projectSlug,
      source: 'eval-run',
    }));
  }

  // Use scoring.json if present.
  type ScoringFile = {
    rows: Array<{ scenarioId: string; scores: { overall: number } }>;
  };
  let scoring: ScoringFile | null = null;
  try {
    const txt = await fs.readFile(path.join(args.runDir, 'scoring.json'), 'utf8');
    scoring = JSON.parse(txt) as ScoringFile;
  } catch {
    scoring = null;
  }

  if (!scoring || scoring.rows.length === 0) {
    return completed.slice(0, 3).map((s) => ({
      projectId: s.projectId as string,
      scenarioId: s.scenarioId,
      projectSlug: s.projectSlug,
      source: 'eval-run',
    }));
  }

  const sorted = [...scoring.rows].sort((a, b) => b.scores.overall - a.scores.overall);
  const best = sorted[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = sorted[sorted.length - 1];
  const wantIds = new Set(
    [best?.scenarioId, median?.scenarioId, worst?.scenarioId].filter(Boolean),
  );
  return completed
    .filter((s) => wantIds.has(s.scenarioId))
    .map((s) => ({
      projectId: s.projectId as string,
      scenarioId: s.scenarioId,
      projectSlug: s.projectSlug,
      source: 'eval-run',
    }));
}

function scenarioForProject(project: ProjectInfo): Scenario {
  return {
    id: project.scenarioId,
    domain: project.source === 'local-studio' ? 'Local Studio Project' : 'Arch Eval Project',
    projectName: project.projectName ?? project.projectSlug ?? project.scenarioId,
    seedMessage:
      'Existing local project selected for runtime-aware IN_PROJECT battle testing. Use the actual project agents, topology, tools, auth profiles, variables, model config, diagnostics, and runtime behavior as the source of truth.',
    channels: ['Existing project channels'],
    language: 'Existing project language',
    capabilities:
      'Runtime-aware audit of agent management, tool management, health checks, proposal quality, and approval safety against the current project context.',
    complexity: 'medium',
    expectedAgents: project.agentCount ?? 1,
  };
}

async function loadScenarioMeta(
  args: CliArgs,
  projects: ProjectInfo[],
): Promise<Map<string, Scenario>> {
  if (args.discoverLocalProjects) {
    return new Map(projects.map((project) => [project.scenarioId, scenarioForProject(project)]));
  }

  const file = path.join(args.runDir, 'scenarios.json');
  try {
    const arr = JSON.parse(await fs.readFile(file, 'utf8')) as Scenario[];
    return new Map(arr.map((s) => [s.id, s]));
  } catch (err) {
    if (projects.length === 0) {
      return new Map();
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const outDir = path.join(args.runDir, 'in-project');
  await fs.mkdir(outDir, { recursive: true });

  const projects = await loadProjects(args);
  const scenarios = await loadScenarioMeta(args, projects);
  await fs.writeFile(
    path.join(outDir, 'selected-projects.json'),
    JSON.stringify(projects, null, 2),
    'utf8',
  );
  process.stdout.write(`[in-project] ${projects.length} project(s) selected\n`);

  const allRecords: Array<{
    projectId: string;
    scenarioId: string;
    sessionId: string;
    turns: TurnRecord[];
    overallScore: number;
    runtimeContextScore: RuntimeContextScore;
    finalRuntimeContextScore: RuntimeContextScore;
  }> = [];

  for (const proj of projects) {
    process.stdout.write(`[in-project] === ${proj.scenarioId} (${proj.projectId}) ===\n`);
    const token = await devLogin(args.studioUrl, args.email);
    const sessionRes = await postJson<{ sessionId: string }>(
      `${args.studioUrl}/api/arch-ai/sessions`,
      { projectId: proj.projectId },
      token,
    );
    if (!sessionRes.ok || !sessionRes.data?.sessionId) {
      process.stderr.write(
        `[in-project] failed to create session for ${proj.projectId}: ${sessionRes.text}\n`,
      );
      continue;
    }
    const sessionId = sessionRes.data.sessionId;
    const scenarioMeta = scenarios.get(proj.scenarioId);
    if (!scenarioMeta) {
      process.stderr.write(`[in-project] scenario meta missing for ${proj.scenarioId}\n`);
      continue;
    }

    const turns: TurnRecord[] = [];
    for (const turn of PLAYBOOK) {
      process.stdout.write(`[in-project]   turn: ${turn.name}\n`);
      try {
        const rec = await runTurn(args.studioUrl, token, sessionId, turn, scenarioMeta);
        turns.push(rec);
        process.stdout.write(
          `[in-project]   ${turn.name} -> score ${rec.reasoningScore.toFixed(1)} (${rec.toolCalls.length} tool calls, ${rec.errorEvents.length} errors)\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[in-project] turn ${turn.name} crashed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    const projectDir = path.join(outDir, proj.scenarioId);
    await fs.mkdir(projectDir, { recursive: true });
    for (const t of turns) {
      const turnDir = path.join(projectDir, t.turnName);
      await fs.mkdir(turnDir, { recursive: true });
      await fs.writeFile(
        path.join(turnDir, 'events.ndjson'),
        t.events.map((e) => JSON.stringify(e)).join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(turnDir, 'turn.json'),
        JSON.stringify(
          {
            turnName: t.turnName,
            request: t.request,
            rubric: t.rubric,
            durationMs: t.durationMs,
            toolCalls: t.toolCalls.map((c) => ({
              toolName: c.toolName,
              toolCallId: c.toolCallId,
              isError: c.isError,
              input: c.input,
            })),
            proposedModification: t.proposedModification,
            appliedModification: t.appliedModification,
            errorEvents: t.errorEvents,
            reasoningScore: t.reasoningScore,
            scoreNotes: t.scoreNotes,
            runtimeContextScore: t.runtimeContextScore,
          },
          null,
          2,
        ),
        'utf8',
      );
    }
    const overallScore =
      turns.reduce((sum, t) => sum + t.reasoningScore, 0) / Math.max(1, turns.length);
    const runtimeContextScore = combineRuntimeContextScores(turns);
    const finalRuntimeContextScore = combineFinalRuntimeValidationScores(turns);
    allRecords.push({
      projectId: proj.projectId,
      scenarioId: proj.scenarioId,
      sessionId,
      turns,
      overallScore,
      runtimeContextScore,
      finalRuntimeContextScore,
    });
  }

  await fs.writeFile(
    path.join(outDir, 'in-project-summary.json'),
    JSON.stringify(allRecords, null, 2),
    'utf8',
  );

  let pm2LogCapture: { ok: boolean; output: string } | null = null;
  if (!args.skipPm2Logs) {
    pm2LogCapture = await capturePm2Logs();
    await fs.writeFile(path.join(outDir, 'pm2-tail.log'), pm2LogCapture.output, 'utf8');
  }

  // Markdown report
  const lines: string[] = [];
  lines.push('# IN_PROJECT Modification Playbook — Results');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} · ${allRecords.length} project(s)`);
  if (pm2LogCapture) {
    lines.push(`PM2 log capture: ${pm2LogCapture.ok ? 'captured' : 'failed'} at \`pm2-tail.log\``);
  }
  lines.push('');
  lines.push(
    '| Scenario | Avg Score | Final Runtime Context | Final Ready | All-Turn Runtime Context | Pass | Fail | Missing |',
  );
  lines.push('|---|---:|---:|---|---:|---:|---:|---:|');
  for (const rec of allRecords) {
    lines.push(
      `| ${rec.scenarioId} | ${rec.overallScore.toFixed(1)} | ${rec.finalRuntimeContextScore.score}% | ${rec.finalRuntimeContextScore.ready ? 'yes' : 'no'} | ${rec.runtimeContextScore.score}% | ${rec.finalRuntimeContextScore.passed} | ${rec.finalRuntimeContextScore.failed} | ${rec.finalRuntimeContextScore.missing} |`,
    );
  }
  lines.push('');
  lines.push('## Final Runtime Context Gates');
  lines.push('');
  lines.push(
    '| Scenario | AgentIR | Compile | Topology | Tools | Auth/Vars | Model | Diagnostics | Smoke |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const rec of allRecords) {
    const score = rec.finalRuntimeContextScore;
    lines.push(
      `| ${rec.scenarioId} | ${score.agentIRResolved.status} | ${score.projectCompilePassed.status} | ${score.topologyConsistent.status} | ${score.toolBindingsResolved.status} | ${score.authVariablesResolved.status} | ${score.modelConfigResolved.status} | ${score.diagnosticsCleanOrExplained.status} | ${score.runtimeFlowSmokePassed.status} |`,
    );
  }
  lines.push('');
  lines.push('## Detail');
  for (const rec of allRecords) {
    lines.push('');
    lines.push(`### ${rec.scenarioId} (project ${rec.projectId})`);
    lines.push('');
    lines.push(`**session**: ${rec.sessionId}`);
    lines.push(
      `**final runtime context**: ${rec.finalRuntimeContextScore.score}% (${rec.finalRuntimeContextScore.ready ? 'ready' : 'not ready'})`,
    );
    lines.push(
      `**all-turn runtime context**: ${rec.runtimeContextScore.score}% (${rec.runtimeContextScore.ready ? 'ready' : 'not ready'})`,
    );
    if (rec.finalRuntimeContextScore.blockers.length > 0) {
      lines.push(`**runtime blockers**: ${rec.finalRuntimeContextScore.blockers.join('; ')}`);
    }
    for (const t of rec.turns) {
      lines.push('');
      lines.push(`#### turn ${t.turnName} — score ${t.reasoningScore.toFixed(1)}`);
      lines.push(`- request: ${t.request}`);
      lines.push(`- rubric: ${t.rubric}`);
      lines.push(`- duration: ${(t.durationMs / 1000).toFixed(1)}s`);
      lines.push(
        `- tool calls: ${t.toolCalls.map((c) => `${c.toolName}${c.isError ? '✗' : ''}`).join(', ') || '—'}`,
      );
      lines.push(`- propose: ${t.proposedModification ? 'yes' : 'no'}`);
      lines.push(`- apply:   ${t.appliedModification ? 'yes' : 'no'}`);
      lines.push(`- errors:  ${t.errorEvents.length}`);
      lines.push(
        `- runtime-context: ${t.runtimeContextScore.score}% (${t.runtimeContextScore.passed} pass, ${t.runtimeContextScore.failed} fail, ${t.runtimeContextScore.missing} missing)`,
      );
      if (t.runtimeContextScore.blockers.length > 0) {
        lines.push(`- runtime blockers: ${t.runtimeContextScore.blockers.slice(0, 5).join('; ')}`);
      }
      if (t.scoreNotes.length) lines.push(`- notes:   ${t.scoreNotes.join('; ')}`);
    }
  }
  await fs.writeFile(path.join(outDir, 'in-project-summary.md'), lines.join('\n'), 'utf8');
  process.stdout.write(`[in-project] wrote summary at ${outDir}/in-project-summary.md\n`);
}

main().catch((err) => {
  process.stderr.write(`[in-project] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
