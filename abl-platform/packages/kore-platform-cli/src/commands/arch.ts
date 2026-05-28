/**
 * Arch AI commands — drive the arch-ai engine via Studio HTTP+SSE routes.
 *
 * Minimal slice: connect (reuses `login`), session new/list/use, send, chat.
 * Pure HTTP client — same path as the browser, no orchestration code in CLI.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Conf from 'conf';

import { createParser } from 'eventsource-parser';
import type { TurnEvent } from '@agent-platform/arch-ai';

import { apiRequest } from '../lib/api-client.js';
import { getApiUrl, getCurrentProjectId } from '../lib/config.js';
import { getToken, isAuthenticated } from '../lib/credentials.js';

// =============================================================================
// LOCAL STATE — active session id only (project lives in main config already)
// =============================================================================

interface ArchCliState {
  currentSessionId?: string;
}

const archConf = new Conf<ArchCliState>({
  projectName: 'kore-platform',
  configName: 'arch-cli',
});

// =============================================================================
// HELPERS
// =============================================================================

function requireAuth(): void {
  if (!isAuthenticated()) {
    process.stderr.write(chalk.red('Not authenticated. Run: kore-platform-cli login\n'));
    process.exit(1);
  }
}

function requireSession(override?: string): string {
  const sessionId = override ?? archConf.get('currentSessionId');
  if (!sessionId) {
    process.stderr.write(chalk.red('No active session. Run: kore-platform-cli arch session new\n'));
    process.exit(1);
  }
  return sessionId;
}

function fail(prefix: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(chalk.red(`${prefix}: ${msg}\n`));
  process.exit(1);
}

// =============================================================================
// SSE STREAMING — POST /api/arch-ai/message and render events
// =============================================================================

async function streamMessage(body: unknown): Promise<void> {
  const token = getToken();
  if (!token) {
    fail('streamMessage', new Error('No auth token'));
  }

  const res = await fetch(`${getApiUrl()}/api/arch-ai/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Stream failed (${res.status}): ${errText}`);
  }

  // Parse SSE chunks via eventsource-parser. Server emits one v2 TurnEvent per
  // `event:` line. The data payload already contains the envelope; we only need
  // to inject `type` from the SSE event name.
  const parser = createParser({
    onEvent(msg) {
      if (!msg.data) return;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const event = { type: msg.event ?? 'unknown', ...payload } as TurnEvent;
      renderEvent(event);
    },
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }

  process.stdout.write('\n');
}

function renderEvent(event: TurnEvent): void {
  switch (event.type) {
    case 'turn_started':
      if (event.specialist) {
        process.stdout.write(chalk.cyan(`\n[${event.specialist}]\n`));
      }
      break;

    case 'text_delta':
      process.stdout.write(event.delta);
      break;

    case 'status': {
      if (event.progress) {
        process.stdout.write(
          chalk.gray(`\n[${event.progress.step}/${event.progress.total}] ${event.label}\n`),
        );
      } else {
        process.stdout.write(chalk.gray(`\n· ${event.label}\n`));
      }
      if (process.env.ARCH_VERBOSE && event.activity) {
        process.stdout.write(chalk.dim(`  activity: ${JSON.stringify(event.activity)}\n`));
      }
      break;
    }

    case 'artifact_updated':
      if (process.env.ARCH_VERBOSE) {
        process.stdout.write(chalk.dim(`\n· artifact: ${JSON.stringify(event.update)}\n`));
      } else {
        process.stdout.write(chalk.gray(`\n📄 artifact updated\n`));
      }
      break;

    case 'interactive_tool': {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (event.kind === 'gate') {
        const gateType = (payload?.gateType as string | undefined) ?? event.tool;
        process.stdout.write(chalk.yellow(`\n→ gate [id=${event.toolCallId}] ${gateType}\n`));
        process.stdout.write(chalk.gray(`  data: ${JSON.stringify(payload?.data ?? payload)}\n`));
        process.stdout.write(
          chalk.gray(
            `  reply: kore-platform-cli arch reply ${event.toolCallId} --answer '<json>'\n`,
          ),
        );
      } else {
        const isAsk = event.tool === 'ask_user' || event.tool === 'collect_file';
        if (isAsk) {
          process.stdout.write(chalk.yellow(`\n→ widget [id=${event.toolCallId}] ${event.tool}\n`));
          process.stdout.write(chalk.gray(`  input: ${JSON.stringify(payload)}\n`));
          process.stdout.write(
            chalk.gray(
              `  reply: kore-platform-cli arch reply ${event.toolCallId} --answer '<json>'\n`,
            ),
          );
        } else {
          process.stdout.write(chalk.gray(`\n→ tool: ${event.tool}\n`));
          if (process.env.ARCH_VERBOSE) {
            process.stdout.write(chalk.dim(`  payload: ${JSON.stringify(payload)}\n`));
          }
        }
      }
      break;
    }

    case 'turn_committed':
      if (process.env.ARCH_VERBOSE) {
        process.stdout.write(
          chalk.dim(
            `\n· committed phase=${event.phase}${event.autoContinue ? ' auto-continue' : ''}\n`,
          ),
        );
      }
      break;

    case 'turn_ended': {
      if (event.error) {
        const code = event.error.code ?? 'UNKNOWN';
        const message = event.error.message ?? JSON.stringify(event.error);
        process.stdout.write(chalk.red(`\n[error:${code}] ${message}\n`));
      } else if (event.reason !== 'natural') {
        process.stdout.write(chalk.yellow(`\n[turn_ended] reason=${event.reason}\n`));
      }
      if (process.env.ARCH_VERBOSE && event.suggestions?.length) {
        process.stdout.write(chalk.dim(`  suggestions: ${JSON.stringify(event.suggestions)}\n`));
      }
      break;
    }

    case 'error':
      if (event.error && typeof event.error === 'object') {
        const error = event.error as { code?: string; message?: string };
        const code = error.code ?? 'UNKNOWN';
        const message = error.message ?? JSON.stringify(event.error);
        process.stdout.write(chalk.red(`\n[error:${code}] ${message}\n`));
      } else {
        process.stdout.write(chalk.red(`\n[error:UNKNOWN] ${JSON.stringify(event)}\n`));
      }
      break;

    case 'phase_transition':
      process.stdout.write(
        chalk.bold(
          `\n=== PHASE: ${event.from} → ${event.to}${event.reason ? ` (${event.reason})` : ''} ===\n`,
        ),
      );
      break;

    default:
      if (process.env.ARCH_VERBOSE) {
        process.stdout.write(
          chalk.dim(
            `\n[${(event as { type?: string }).type ?? 'unknown'}] ${JSON.stringify(event)}\n`,
          ),
        );
      }
  }
}

// =============================================================================
// COMMAND HANDLERS
// =============================================================================

interface SessionListItem {
  id: string;
  state: string;
  metadata: { mode?: string; phase?: string; projectId?: string };
}

async function sessionNew(opts: { project?: string }): Promise<void> {
  requireAuth();
  // Fall back to active project from main CLI config if --project not passed
  const projectId = opts.project ?? getCurrentProjectId();
  try {
    const body = projectId ? { projectId } : {};
    const res = await apiRequest<{ sessionId: string }>('/api/arch-ai/sessions', {
      method: 'POST',
      body,
    });
    archConf.set('currentSessionId', res.sessionId);
    process.stdout.write(chalk.green(`✓ session created: ${res.sessionId}\n`));
    process.stdout.write(chalk.gray(`  mode: ${projectId ? 'IN_PROJECT' : 'ONBOARDING'}\n`));
    if (projectId) process.stdout.write(chalk.gray(`  project: ${projectId}\n`));
    process.stdout.write(chalk.gray(`  set as active\n`));
  } catch (err) {
    fail('Failed to create session', err);
  }
}

// =============================================================================
// EXTRA COMMAND HANDLERS — reply, resume, archive, checkpoints, rollback,
// files upload, summary, audit, health, workspace
// =============================================================================

function parseAnswerArg(raw: string): unknown {
  // Allow --answer '"yes"' (JSON string), '{...}', '["a","b"]', or plain text
  const trimmed = raw.trim();
  if (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('"') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to plain string
    }
  }
  return raw;
}

async function reply(
  toolCallId: string,
  opts: { answer: string; session?: string },
): Promise<void> {
  requireAuth();
  const sessionId = requireSession(opts.session);
  const answer = parseAnswerArg(opts.answer);
  try {
    await streamMessage({ sessionId, type: 'tool_answer', toolCallId, answer });
  } catch (err) {
    fail('Reply failed', err);
  }
}

interface SessionDetail {
  session: { id: string; state: string; metadata: Record<string, unknown> };
  resume?: unknown;
}

async function sessionResume(idArg: string | undefined): Promise<void> {
  requireAuth();
  const sessionId = requireSession(idArg);
  try {
    const res = await apiRequest<SessionDetail>(`/api/arch-ai/sessions/${sessionId}`);
    process.stdout.write(chalk.bold(`Session ${sessionId}\n`));
    process.stdout.write(chalk.gray(`  state: ${res.session.state}\n`));
    process.stdout.write(chalk.gray(`  meta:  ${JSON.stringify(res.session.metadata)}\n`));
    if (res.resume) {
      process.stdout.write(chalk.bold('\nResume snapshot:\n'));
      process.stdout.write(JSON.stringify(res.resume, null, 2) + '\n');
    } else {
      process.stdout.write(chalk.gray('\n(no resume snapshot)\n'));
    }
  } catch (err) {
    fail('Failed to fetch session', err);
  }
}

async function sessionArchive(idArg: string | undefined): Promise<void> {
  requireAuth();
  const sessionId = requireSession(idArg);
  try {
    await apiRequest<{ ok: boolean }>(`/api/arch-ai/sessions/${sessionId}/archive`, {
      method: 'POST',
      body: {},
    });
    if (archConf.get('currentSessionId') === sessionId) {
      archConf.delete('currentSessionId');
    }
    process.stdout.write(chalk.green(`✓ archived ${sessionId}\n`));
  } catch (err) {
    fail('Archive failed', err);
  }
}

interface CheckpointPreview {
  checkpointId: string;
  phase: string;
  trigger: string;
  timestamp: string;
  messageCount: number;
}

async function sessionCheckpoints(idArg: string | undefined): Promise<void> {
  requireAuth();
  const sessionId = requireSession(idArg);
  try {
    const res = await apiRequest<{ checkpoints: CheckpointPreview[] }>(
      `/api/arch-ai/sessions/${sessionId}/checkpoints`,
    );
    if (!res.checkpoints || res.checkpoints.length === 0) {
      process.stdout.write(chalk.yellow('No checkpoints.\n'));
      return;
    }
    for (const cp of res.checkpoints) {
      process.stdout.write(
        `${chalk.cyan(cp.checkpointId)}  ${cp.phase}  ${cp.trigger}  msgs=${cp.messageCount}  ${cp.timestamp}\n`,
      );
    }
  } catch (err) {
    fail('Failed to list checkpoints', err);
  }
}

async function sessionRollback(checkpointId: string, opts: { session?: string }): Promise<void> {
  requireAuth();
  const sessionId = requireSession(opts.session);
  try {
    await apiRequest<unknown>(`/api/arch-ai/sessions/${sessionId}/rollback`, {
      method: 'POST',
      body: { checkpointId },
    });
    process.stdout.write(chalk.green(`✓ rolled back ${sessionId} to ${checkpointId}\n`));
  } catch (err) {
    fail('Rollback failed', err);
  }
}

async function filesUpload(filePath: string, opts: { session?: string }): Promise<void> {
  requireAuth();
  const sessionId = requireSession(opts.session);
  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (err) {
    fail(`Failed to read ${filePath}`, err);
  }
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeByExt: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.yaml': 'application/x-yaml',
    '.yml': 'application/x-yaml',
    '.txt': 'text/plain',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  const type = mimeByExt[ext] ?? 'application/octet-stream';
  const content = buf.toString('base64');
  try {
    const res = await apiRequest<{ data: { blobId: string; tokenCost?: number } }>(
      '/api/arch-ai/files',
      {
        method: 'POST',
        body: {
          sessionId,
          file: { name, type, size: buf.byteLength, content },
        },
      },
    );
    process.stdout.write(chalk.green(`✓ uploaded: ${name}\n`));
    process.stdout.write(chalk.gray(`  blobId: ${res.data.blobId}\n`));
    if (typeof res.data.tokenCost === 'number') {
      process.stdout.write(chalk.gray(`  tokens: ${res.data.tokenCost}\n`));
    }
  } catch (err) {
    fail('Upload failed', err);
  }
}

async function summary(opts: { project?: string }): Promise<void> {
  requireAuth();
  const projectId = opts.project ?? getCurrentProjectId();
  if (!projectId) {
    fail('summary', new Error('No active project. Run: kore-platform-cli projects use <slug>'));
  }
  try {
    const res = await apiRequest<{ summary: unknown }>(
      `/api/arch-ai/project-summary?projectId=${encodeURIComponent(projectId)}`,
    );
    process.stdout.write(JSON.stringify(res.summary, null, 2) + '\n');
  } catch (err) {
    fail('Failed to fetch summary', err);
  }
}

async function health(opts: { project?: string }): Promise<void> {
  requireAuth();
  const projectId = opts.project ?? getCurrentProjectId();
  if (!projectId) {
    fail('health', new Error('No active project. Run: kore-platform-cli projects use <slug>'));
  }
  try {
    const res = await apiRequest<unknown>(
      `/api/arch-ai/project-health?projectId=${encodeURIComponent(projectId)}`,
    );
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } catch (err) {
    fail('Failed to fetch health', err);
  }
}

interface AuditEntry {
  _id?: string;
  category: string;
  severity: string;
  phase?: string;
  specialist?: string;
  summary?: string;
  createdAt: string;
}

async function auditTail(opts: { limit: string; severity?: string }): Promise<void> {
  requireAuth();
  const limit = Number.parseInt(opts.limit, 10) || 50;
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.severity) params.set('severity', opts.severity);
  try {
    const res = await apiRequest<{ entries?: AuditEntry[]; data?: AuditEntry[] }>(
      `/api/arch-ai/audit-logs?${params.toString()}`,
    );
    const entries = res.entries ?? res.data ?? [];
    if (entries.length === 0) {
      process.stdout.write(chalk.yellow('No audit entries.\n'));
      return;
    }
    for (const e of entries) {
      const sev =
        e.severity === 'error'
          ? chalk.red(e.severity)
          : e.severity === 'warn'
            ? chalk.yellow(e.severity)
            : chalk.gray(e.severity);
      process.stdout.write(
        `${e.createdAt}  ${sev}  ${e.category}  ${e.phase ?? '-'}  ${e.summary ?? ''}\n`,
      );
    }
  } catch (err) {
    fail('Failed to fetch audit logs', err);
  }
}

interface TenantEntry {
  tenantId: string;
  tenantName: string;
  role: string;
  orgId?: string;
}

async function workspaceList(): Promise<void> {
  requireAuth();
  try {
    const res = await apiRequest<{ tenants: TenantEntry[] }>('/api/auth/tenants');
    if (!res.tenants || res.tenants.length === 0) {
      process.stdout.write(chalk.yellow('No tenants found.\n'));
      return;
    }
    for (const t of res.tenants) {
      process.stdout.write(`${chalk.cyan(t.tenantId)}  ${t.tenantName}  ${chalk.gray(t.role)}\n`);
    }
    process.stdout.write(
      chalk.gray(
        '\nNote: tenant binding is part of your auth token. To switch tenants, re-login.\n',
      ),
    );
  } catch (err) {
    fail('Failed to list workspaces', err);
  }
}

async function sessionList(): Promise<void> {
  requireAuth();
  try {
    const res = await apiRequest<{ sessions: SessionListItem[] }>('/api/arch-ai/sessions');
    if (!res.sessions || res.sessions.length === 0) {
      process.stdout.write(chalk.yellow('No sessions found.\n'));
      return;
    }
    const current = archConf.get('currentSessionId');
    for (const s of res.sessions) {
      const marker = s.id === current ? chalk.green('*') : ' ';
      const meta = `${s.metadata.mode ?? '?'}/${s.metadata.phase ?? '?'}`;
      process.stdout.write(`${marker} ${chalk.cyan(s.id)}  ${meta}  ${s.state}\n`);
    }
  } catch (err) {
    fail('Failed to list sessions', err);
  }
}

function sessionUse(sessionId: string): void {
  archConf.set('currentSessionId', sessionId);
  process.stdout.write(chalk.green(`✓ active session: ${sessionId}\n`));
}

async function send(text: string, opts: { session?: string }): Promise<void> {
  requireAuth();
  const sessionId = requireSession(opts.session);
  try {
    await streamMessage({ sessionId, type: 'message', text });
  } catch (err) {
    fail('Send failed', err);
  }
}

async function createProject(opts: { session?: string }): Promise<void> {
  requireAuth();
  const sessionId = requireSession(opts.session);
  try {
    await streamMessage({ sessionId, type: 'create' });
  } catch (err) {
    fail('Create failed', err);
  }
}

async function chat(opts: { session?: string }): Promise<void> {
  requireAuth();
  const sessionId = requireSession(opts.session);

  process.stdout.write(chalk.gray(`Chat session: ${sessionId}\n`));
  process.stdout.write(chalk.gray('Type your message. Ctrl+D or "exit" to quit.\n\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold('arch> '),
  });

  const prompt = (): void => {
    rl.prompt();
  };

  prompt();

  rl.on('line', async (line: string) => {
    const text = line.trim();
    if (!text) {
      prompt();
      return;
    }
    if (text === 'exit' || text === 'quit') {
      rl.close();
      return;
    }
    rl.pause();
    try {
      await streamMessage({ sessionId, type: 'message', text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(chalk.red(`Failed: ${msg}\n`));
    }
    rl.resume();
    prompt();
  });

  rl.on('close', () => {
    process.stdout.write(chalk.gray('\nbye\n'));
    process.exit(0);
  });
}

// =============================================================================
// REGISTRATION
// =============================================================================

export function registerArchCommands(program: Command): void {
  const arch = program
    .command('arch')
    .description(
      'Drive the Arch AI engine — create projects, modify in-project, battle-test (no browser)',
    );

  const session = arch.command('session').description('Manage Arch AI sessions');

  session
    .command('new')
    .description(
      'Create a new Arch AI session (ONBOARDING if no project, IN_PROJECT with --project)',
    )
    .option('-p, --project <id>', 'Bind to an existing project (IN_PROJECT mode)')
    .action(sessionNew);

  session.command('list').alias('ls').description('List sessions').action(sessionList);

  session.command('use <sessionId>').description('Set active session').action(sessionUse);

  session
    .command('resume [sessionId]')
    .description('Show resume snapshot for a session (defaults to active)')
    .action(sessionResume);

  session
    .command('archive [sessionId]')
    .description('Archive a session (defaults to active)')
    .action(sessionArchive);

  session
    .command('checkpoints [sessionId]')
    .description('List checkpoints for a session (defaults to active)')
    .action(sessionCheckpoints);

  session
    .command('rollback <checkpointId>')
    .description('Roll back active session to a checkpoint')
    .option('-s, --session <id>', 'Override active session')
    .action(sessionRollback);

  arch
    .command('send <text>')
    .description('Send one message to active session, stream response, exit on done')
    .option('-s, --session <id>', 'Override active session')
    .action(send);

  arch
    .command('chat')
    .description('Interactive chat REPL with active session')
    .option('-s, --session <id>', 'Override active session')
    .action(chat);

  arch
    .command('reply <toolCallId>')
    .description('Reply to an ask_user / collect_file widget on the active session')
    .requiredOption('-a, --answer <json>', 'Answer payload as JSON or plain string')
    .option('-s, --session <id>', 'Override active session')
    .action(reply);

  arch
    .command('create')
    .description(
      'Trigger deterministic project creation in CREATE phase (equivalent to clicking "Create Project")',
    )
    .option('-s, --session <id>', 'Override active session')
    .action(createProject);

  const files = arch.command('files').description('File attachments for sessions');
  files
    .command('upload <path>')
    .description('Upload a file and print the blobId')
    .option('-s, --session <id>', 'Override active session')
    .action(filesUpload);

  arch
    .command('summary')
    .description('Print project summary (active project from `projects use`, or --project)')
    .option('-p, --project <id>', 'Override active project')
    .action(summary);

  arch
    .command('health')
    .description('Print project health (active project, or --project)')
    .option('-p, --project <id>', 'Override active project')
    .action(health);

  arch
    .command('audit')
    .description('Audit log helpers')
    .command('tail')
    .description('Fetch recent audit log entries (admin only)')
    .option('-l, --limit <n>', 'Max entries', '50')
    .option('--severity <sev>', 'Filter by severity (info|warn|error)')
    .action(auditTail);

  const workspace = arch.command('workspace').description('Tenant (workspace) helpers');
  workspace
    .command('list')
    .alias('ls')
    .description('List tenants you belong to')
    .action(workspaceList);
}
