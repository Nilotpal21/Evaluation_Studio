/**
 * Repro: free-text after BuildComplete widget appears in CREATE phase.
 *
 * Drives a real scenario through INTERVIEW → BLUEPRINT → BUILD via the same
 * SSE routes the browser uses (reusing run-scenario.ts auto-reply policy),
 * then when CREATE phase is reached:
 *   - Original harness: sends `{type: 'create'}` to finalize deterministically.
 *   - This repro:       sends `{type: 'message', text: <free-text>}` instead,
 *                       simulating a user who types into the chat box rather
 *                       than clicking the Create Project button.
 *
 * Output:
 *   docs/testing/arch-eval/repro-create-freetext-<ts>/
 *     phase.log       — phase + pending state at each step
 *     turns.ndjson    — one line per turn with summary + key events
 *     bug-proof.md    — human-readable summary
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { decideReply, type InteractiveToolEvent } from './auto-reply.js';
import { SCENARIOS } from './scenarios.js';

const SCENARIO_ID = 's21-returns-fraud-ecomm';
const STREAM_TIMEOUT_MS = 7 * 60 * 1000;
const FREE_TEXT_MUTATION =
  'Actually, before creating, can you add a dispute handler agent that talks to the fraud agent?';
const FREE_TEXT_AFFIRMATIVE = 'Yes go ahead and create the project now.';
const MAX_STEPS = 200;

interface CliArgs {
  email: string;
  studioUrl: string;
  outputRoot: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const out: Partial<CliArgs> = {
    email: 'test@example.com',
    studioUrl: 'http://localhost:5173',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--studio') out.studioUrl = argv[++i];
  }
  if (!out.outputRoot) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    out.outputRoot = path.join(
      process.cwd(),
      'docs/testing/arch-eval',
      `repro-create-freetext-${ts}`,
    );
  }
  return out as CliArgs;
}

interface SSEEvent {
  type: string;
  [k: string]: unknown;
}

interface TurnSummary {
  turn: number;
  body: unknown;
  events: SSEEvent[];
  endedReason: 'eof' | 'error' | 'timeout';
  errorMessage?: string;
  durationMs: number;
}

interface PendingWidget {
  kind?: string;
  id?: string;
  payload?: {
    widgetType?: string;
    options?: Array<{ value: string; label?: string }>;
    allowCustom?: boolean;
  };
}

interface SessionShape {
  state?: string;
  metadata: {
    phase?: string;
    projectId?: string;
    pendingInteraction?: PendingWidget | null;
  };
}

async function devLogin(studio: string, email: string): Promise<string> {
  const res = await fetch(`${studio}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'CREATE Free-Text Repro' }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status}`);
  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) throw new Error('dev-login returned no accessToken');
  return data.accessToken;
}

async function fetchSession(studio: string, token: string, sessionId: string) {
  const res = await fetch(`${studio}/api/arch-ai/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { session?: SessionShape };
  return body.session;
}

async function postJson<T>(url: string, body: unknown, token: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function streamMessage(
  studioUrl: string,
  token: string,
  body: unknown,
  onSse: (e: SSEEvent) => void,
): Promise<TurnSummary> {
  const start = Date.now();
  const events: SSEEvent[] = [];
  let endedReason: TurnSummary['endedReason'] = 'eof';
  let errorMessage: string | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    endedReason = 'timeout';
    ctrl.abort();
  }, STREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${studioUrl}/api/arch-ai/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      return {
        turn: 0,
        body,
        events,
        endedReason: 'error',
        errorMessage: `HTTP ${res.status}: ${text}`,
        durationMs: Date.now() - start,
      };
    }
    const parser = createParser({
      onEvent(msg: EventSourceMessage) {
        if (!msg.data) return;
        try {
          const payload = JSON.parse(msg.data) as Record<string, unknown>;
          const event: SSEEvent = { type: msg.event ?? 'unknown', ...payload };
          events.push(event);
          onSse(event);
          if (event.type === 'error') {
            endedReason = 'error';
            const err = event.error as { message?: string } | undefined;
            errorMessage = err?.message;
          }
        } catch {
          /* skip non-JSON */
        }
      },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (endedReason !== 'timeout') {
      endedReason = 'error';
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
  }
  return { turn: 0, body, events, endedReason, errorMessage, durationMs: Date.now() - start };
}

async function main() {
  const cfg = parseArgs();
  const scenario = SCENARIOS.find((s) => s.id === SCENARIO_ID);
  if (!scenario) throw new Error(`Scenario ${SCENARIO_ID} not found`);

  await fs.mkdir(cfg.outputRoot, { recursive: true });
  const phaseLog: string[] = [];
  const turnsHandle = await fs.open(path.join(cfg.outputRoot, 'turns.ndjson'), 'w');

  const log = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    phaseLog.push(stamped);
    console.log(stamped);
  };

  log(`Repro target: ${SCENARIO_ID}`);
  log(`Studio: ${cfg.studioUrl}`);

  const token = await devLogin(cfg.studioUrl, cfg.email);
  log('dev-login ok');

  // Create session with seed message
  const projectName = `${scenario.projectName}-freetext-${Date.now().toString(36)}`;
  const sessionRes = await postJson<{ sessionId: string }>(
    `${cfg.studioUrl}/api/arch-ai/sessions`,
    {
      mode: 'ONBOARDING',
      seedMessage: scenario.seedMessage,
      seedMessageVariables: {
        projectName,
        channels: scenario.channels,
        language: scenario.language,
        capabilities: scenario.capabilities,
      },
    },
    token,
  );
  const sessionId = sessionRes.sessionId;
  log(`session: ${sessionId}`);

  let turnNum = 0;
  const writeTurn = async (s: TurnSummary) => {
    s.turn = ++turnNum;
    await turnsHandle.appendFile(JSON.stringify(s) + '\n');
  };

  // Event queue — matches run-scenario.ts pattern (push interactive_tool from SSE)
  const interactiveQueue: InteractiveToolEvent[] = [];
  const turnHistory: Array<{ tool: string; question: string | undefined }> = [];
  const onSse = (event: SSEEvent) => {
    if (event.type === 'interactive_tool') {
      interactiveQueue.push(event as unknown as InteractiveToolEvent);
    } else if (event.type === 'tool_call') {
      const toolName = (event as { toolName?: string }).toolName;
      const toolCallId = (event as { toolCallId?: string }).toolCallId;
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
    }
  };

  const send = (body: unknown) => streamMessage(cfg.studioUrl, token, body, onSse);

  // ── Drive INTERVIEW → BLUEPRINT → BUILD until BuildComplete pending ───
  let bugReached = false;
  for (let i = 0; i < MAX_STEPS; i++) {
    const next = interactiveQueue.shift();
    if (next) {
      const decision = decideReply(next, scenario, turnHistory);
      const q = (next.payload as { question?: string }).question;
      turnHistory.push({ tool: next.tool, question: q });
      if (decision.kind === 'stop') {
        log(`step ${i}: stop — ${decision.reason}`);
        break;
      }
      if (decision.kind === 'skip') {
        log(`step ${i}: skip — ${decision.reason}`);
        continue;
      }
      log(
        `step ${i}: tool_answer for ${next.tool} (toolCallId=${decision.toolCallId.slice(0, 20)}…) answer=${JSON.stringify(decision.answer).slice(0, 80)}`,
      );
      const r = await send({
        sessionId,
        type: 'tool_answer',
        toolCallId: decision.toolCallId,
        answer: decision.answer,
      });
      await writeTurn(r);
      if (r.endedReason === 'error') log(`  ! error: ${r.errorMessage}`);
      continue;
    }

    // Queue empty — check session state
    const session = await fetchSession(cfg.studioUrl, token, sessionId);
    if (!session) break;
    const phase = session.metadata.phase ?? '?';
    const pi = session.metadata.pendingInteraction;
    const pendingKind = pi?.kind;
    const widgetType = pi?.payload?.widgetType;
    const projectId = session.metadata.projectId;
    log(
      `step ${i}: phase=${phase} pending=${pendingKind ?? 'none'}${widgetType ? ` (${widgetType})` : ''} projectId=${projectId ?? 'none'} state=${session.state}`,
    );

    if (phase === 'CREATE' && pendingKind === 'widget' && widgetType === 'BuildComplete') {
      bugReached = true;
      log('▶ reached CREATE + BuildComplete widget — entering bug repro path');
      break;
    }
    if (pendingKind === 'widget' && widgetType === 'BuildComplete') {
      bugReached = true;
      log(`▶ BuildComplete widget pending in ${phase} — entering bug repro path`);
      break;
    }
    if (phase === 'CREATE' && !pendingKind && projectId) {
      log('⚠ project already created — different code path; aborting repro');
      break;
    }

    // No widget queued, no pending widget — nudge per phase
    if (phase === 'BUILD') {
      // BUILD streams sequentially without explicit nudges — just poll
      log('  ⏳ BUILD in-flight; sleeping 6s');
      await new Promise((r) => setTimeout(r, 6000));
      continue;
    }
    if (pendingKind === 'widget' && pi?.id) {
      // pending widget exists but no interactive_tool event in queue — answer from session directly
      const opts = pi.payload?.options ?? [];
      const answer = opts.length > 0 ? opts[0].value : 'continue';
      log(`  → answering pending widget ${widgetType ?? '?'} directly: ${answer}`);
      const r = await send({
        sessionId,
        type: 'tool_answer',
        toolCallId: pi.id,
        answer,
      });
      await writeTurn(r);
      continue;
    }
    const nudge =
      phase === 'INTERVIEW'
        ? 'Proceed to design the architecture.'
        : phase === 'BLUEPRINT'
          ? 'Generate the draft topology now.'
          : 'continue';
    log(`  → nudge ${phase}: ${nudge}`);
    const r = await send({ sessionId, type: 'message', text: nudge });
    await writeTurn(r);
  }

  if (!bugReached) {
    log('FAILED to reach BuildComplete widget. See turns.ndjson.');
    await fs.writeFile(path.join(cfg.outputRoot, 'phase.log'), phaseLog.join('\n'));
    await turnsHandle.close();
    return;
  }

  // ── BUG REPRO PATH ────────────────────────────────────────────────────
  log('═══════════════════════════════════════════════════════════════════');
  const before = await fetchSession(cfg.studioUrl, token, sessionId);
  log(
    `pre-repro: phase=${before?.metadata.phase} pending=${before?.metadata.pendingInteraction?.kind} widgetType=${before?.metadata.pendingInteraction?.payload?.widgetType} projectId=${before?.metadata.projectId ?? 'none'}`,
  );

  log(`>> FREE-TEXT 1 (mutation): ${FREE_TEXT_MUTATION}`);
  const turnA = await send({ sessionId, type: 'message', text: FREE_TEXT_MUTATION });
  await writeTurn(turnA);

  const afterA = await fetchSession(cfg.studioUrl, token, sessionId);
  log(
    `post-1: phase=${afterA?.metadata.phase} pending=${afterA?.metadata.pendingInteraction?.kind ?? 'none'} widgetType=${afterA?.metadata.pendingInteraction?.payload?.widgetType ?? '-'} projectId=${afterA?.metadata.projectId ?? 'none'} endedReason=${turnA.endedReason}`,
  );
  log(
    `  turnA events: ${turnA.events.length} | types: ${[...new Set(turnA.events.map((e) => e.type))].join(', ')}`,
  );

  log('-------------------------------------------------------------------');
  log(`>> FREE-TEXT 2 (affirmative): ${FREE_TEXT_AFFIRMATIVE}`);
  const turnB = await send({ sessionId, type: 'message', text: FREE_TEXT_AFFIRMATIVE });
  await writeTurn(turnB);

  const afterB = await fetchSession(cfg.studioUrl, token, sessionId);
  log(
    `post-2: phase=${afterB?.metadata.phase} pending=${afterB?.metadata.pendingInteraction?.kind ?? 'none'} widgetType=${afterB?.metadata.pendingInteraction?.payload?.widgetType ?? '-'} projectId=${afterB?.metadata.projectId ?? 'none'} endedReason=${turnB.endedReason}`,
  );
  log(
    `  turnB events: ${turnB.events.length} | types: ${[...new Set(turnB.events.map((e) => e.type))].join(', ')}`,
  );

  // ── Assessment ────────────────────────────────────────────────────────
  const bugConfirmed =
    !afterA?.metadata.projectId &&
    !afterB?.metadata.projectId &&
    afterB?.metadata.phase === 'CREATE';

  const md: string[] = [];
  md.push('# CREATE-phase free-text bug — repro proof');
  md.push('');
  md.push(`**Scenario:** ${SCENARIO_ID}`);
  md.push(`**Session:** ${sessionId}`);
  md.push(`**Studio:** ${cfg.studioUrl}`);
  md.push('');
  md.push('## Setup timeline');
  md.push('');
  md.push('| Step | phase | pending | widgetType | projectId | state |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  md.push(
    `| BuildComplete shown | ${before?.metadata.phase} | ${before?.metadata.pendingInteraction?.kind ?? 'none'} | ${before?.metadata.pendingInteraction?.payload?.widgetType ?? '-'} | ${before?.metadata.projectId ?? 'none'} | ${before?.state ?? '?'} |`,
  );
  md.push(
    `| After free-text 1 (mutation) | ${afterA?.metadata.phase} | ${afterA?.metadata.pendingInteraction?.kind ?? 'none'} | ${afterA?.metadata.pendingInteraction?.payload?.widgetType ?? '-'} | ${afterA?.metadata.projectId ?? 'none'} | ${afterA?.state ?? '?'} |`,
  );
  md.push(
    `| After free-text 2 ("yes create") | ${afterB?.metadata.phase} | ${afterB?.metadata.pendingInteraction?.kind ?? 'none'} | ${afterB?.metadata.pendingInteraction?.payload?.widgetType ?? '-'} | ${afterB?.metadata.projectId ?? 'none'} | ${afterB?.state ?? '?'} |`,
  );
  md.push('');
  md.push('## Turn A (mutation request)');
  md.push(`- Body: \`{type: 'message', text: ${JSON.stringify(FREE_TEXT_MUTATION)}}\``);
  md.push(`- endedReason: ${turnA.endedReason}`);
  md.push(`- Events: ${turnA.events.length}`);
  md.push(`- Event types: ${[...new Set(turnA.events.map((e) => e.type))].join(', ')}`);
  md.push(`- Tool calls: ${turnA.events.filter((e) => e.type === 'tool_call').length}`);
  md.push(
    `- Interactive widgets emitted: ${turnA.events.filter((e) => e.type === 'interactive_tool').length}`,
  );
  md.push('');
  md.push('## Turn B (affirmative)');
  md.push(`- Body: \`{type: 'message', text: ${JSON.stringify(FREE_TEXT_AFFIRMATIVE)}}\``);
  md.push(`- endedReason: ${turnB.endedReason}`);
  md.push(`- Events: ${turnB.events.length}`);
  md.push(`- Event types: ${[...new Set(turnB.events.map((e) => e.type))].join(', ')}`);
  md.push(`- Tool calls: ${turnB.events.filter((e) => e.type === 'tool_call').length}`);
  md.push(
    `- Interactive widgets emitted: ${turnB.events.filter((e) => e.type === 'interactive_tool').length}`,
  );
  md.push('');
  md.push('## Assessment');
  md.push('');
  if (bugConfirmed) {
    md.push('**BUG CONFIRMED ✗**');
    md.push('');
    md.push('- Two free-text messages after BuildComplete widget; neither created the project.');
    md.push('- Final `projectId` is empty. Session is still in CREATE phase, idle.');
    md.push(
      '- Root cause (proved by code trace): `PHASE_TOOL_MAP.CREATE = [ask_user, create_project]` but `buildOnboardingToolRegistry()` does NOT register `create_project`. `ToolRegistry.listByNames` silently drops it. The LLM in CREATE only ever sees `ask_user`, can never call `create_project`. Free-text triggers a phantom turn that cannot finalize.',
    );
  } else {
    md.push('**BUG NOT REPRODUCED** in this run.');
    md.push('');
    md.push(`- After free-text mutation: projectId=${afterA?.metadata.projectId ?? 'none'}`);
    md.push(`- After affirmative: projectId=${afterB?.metadata.projectId ?? 'none'}`);
    md.push(`- Final phase: ${afterB?.metadata.phase ?? '?'}`);
  }

  await fs.writeFile(path.join(cfg.outputRoot, 'phase.log'), phaseLog.join('\n'));
  await fs.writeFile(path.join(cfg.outputRoot, 'bug-proof.md'), md.join('\n'));
  await turnsHandle.close();

  log('═══════════════════════════════════════════════════════════════════');
  log(`Bug confirmed: ${bugConfirmed}`);
  log(`Proof written: ${path.join(cfg.outputRoot, 'bug-proof.md')}`);

  // Cleanup
  try {
    await postJson(`${cfg.studioUrl}/api/arch-ai/sessions/${sessionId}/archive`, {}, token);
  } catch {
    /* non-fatal */
  }
}

main().catch((err) => {
  console.error('repro failed:', err);
  process.exit(1);
});
