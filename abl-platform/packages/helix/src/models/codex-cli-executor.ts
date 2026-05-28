import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { serializeStageOutputSchema } from '../pipeline/stage-output-schema.js';
import type {
  ExecutorResult,
  HelixMcpServerDefinition,
  ModelExecutor,
  ModelSpec,
  StageOutputSchemaConfig,
  StreamEvent,
  WorkspaceExecutionContext,
} from '../types.js';
import { ExecutorEfficiencyController } from './executor-efficiency-controller.js';
import {
  buildSourceWorkspaceAliases,
  findSourceWorkspaceAliasInText,
  rewriteTextToExecutionWorkspace,
} from './workspace-grounding.js';

/**
 * Default stall threshold: if no activity (turn completion, command event,
 * stdout output) is observed for this long, Codex is considered stalled and
 * killed.  This replaces the old hard timeout — Codex is free to run as long
 * as it's making progress.
 */
const DEFAULT_STALL_THRESHOLD_MS = 10 * 60_000; // 10 minutes
const STALL_CHECK_INTERVAL_MS = 15_000; // check every 15s
const CODEX_PROMPT_SOFT_LIMIT_BYTES = 900_000;
const CODEX_PROMPT_TARGET_BYTES = 850_000;
const CODEX_SECTION_COMPACTION_NOTE =
  '\n...[HELIX compacted this section to stay below Codex input limits. Use Read/Grep/Glob for any omitted detail.]';
const CODEX_FINAL_COMPACTION_NOTE = [
  '## HELIX Prompt Compaction',
  "HELIX compacted the prompt to stay below Codex's 1MB input limit.",
  'Use Read/Grep/Glob inside the workspace for any omitted detail.',
].join('\n');

const CODEX_SECTION_BUDGETS = [
  {
    heading: '## Scoped Code Map',
    preferredBytes: 180_000,
    minimumBytes: 45_000,
  },
  {
    heading: '## Complete Open Findings Registry',
    preferredBytes: 120_000,
    minimumBytes: 32_000,
  },
  {
    heading: '## Repository Instructions',
    preferredBytes: 60_000,
    minimumBytes: 18_000,
  },
  {
    heading: '## Feature Spec Excerpt',
    preferredBytes: 40_000,
    minimumBytes: 12_000,
  },
  {
    heading: '## Prior HELIX Findings',
    preferredBytes: 24_000,
    minimumBytes: 8_000,
  },
  {
    heading: '## Prior HELIX Decisions',
    preferredBytes: 24_000,
    minimumBytes: 8_000,
  },
  {
    heading: '## Previous Iteration Output',
    preferredBytes: 24_000,
    minimumBytes: 8_000,
  },
  {
    heading: '## SLICE ISSUE BRIEF',
    preferredBytes: 220_000,
    minimumBytes: 80_000,
  },
] as const;

/**
 * Patterns that identify build, test, and lint commands whose wall-clock
 * time should be excluded from the AI reasoning timeout budget.
 *
 * The regex is tested against the command string after stripping a leading
 * `/bin/bash -lc` or `/bin/sh -c` wrapper (common in Codex exec mode).
 */
/**
 * Optional flag token: matches `--flag`, `--flag=value`, or `--flag value`
 * (where value is a non-flag token that doesn't start with `--`).
 */
const OPT_FLAGS = '(?:--\\S+(?:\\s+(?!--)\\S+)?\\s+)*';

const BUILD_TEST_COMMAND_PATTERNS: RegExp[] = [
  // pnpm/npm/yarn with arbitrary flags before the subcommand
  new RegExp(
    `^(?:pnpm|npm|yarn|bun|npx)\\s+${OPT_FLAGS}(?:run\\s+)?(?:build|test|lint|typecheck|check)\\b`,
    'i',
  ),
  // pnpm exec <tool> where tool is a known build/test binary
  new RegExp(
    `^(?:pnpm|npx)\\s+${OPT_FLAGS}exec\\s+(?:vitest|jest|tsc|prettier|eslint|playwright)\\b`,
    'i',
  ),
  /^(?:turbo|turborepo)\s+(?:run\s+)?(?:build|test|lint|typecheck|check)\b/i,
  /^(?:next|nuxt|vite)\s+build\b/i,
  /^tsc\b/i,
  /^(?:npx\s+)?vitest\b/i,
  /^(?:npx\s+)?jest\b/i,
  /^(?:npx\s+)?prettier\b/i,
  /^(?:npx\s+)?eslint\b/i,
  /^(?:npx\s+)?playwright\b/i,
  /^(?:make|cargo|go)\s+(?:build|test)\b/i,
];

const SHELL_WRAPPER_RE = /^\/bin\/(?:ba)?sh\s+-[a-z]*c\s+/;
const SHELL_QUOTE_RE = /^(['"])(.*)\1$/s;
/** Strips leading inline env-var assignments: `VAR=val VAR2=val2 pnpm ...` → `pnpm ...` */
const LEADING_ENV_VARS_RE = /^(?:\w+=\S+\s+)+/;
const NO_MATCH_SEARCH_COMMAND_RE = /^(?:rg|grep)\b/i;
const CODEX_TRANSPORT_LOOKUP_PATTERNS = [
  /failed to lookup address information/i,
  /nodename nor servname provided/i,
  /name or service not known/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
] as const;
const CODEX_HTTP_FALLBACK_PATTERN = /\bfalling back to HTTP\b/i;
const CODEX_HOME_SEED_FILENAMES = [
  'auth.json',
  'config.toml',
  'installation_id',
  '.codex-global-state.json',
] as const;

/**
 * Returns true if the command is a build, test, or lint invocation whose
 * wall-clock time should not count against the AI reasoning budget.
 */
export function isBuildOrTestCommand(command: string): boolean {
  const normalized = normalizeShellCommand(command);
  if (!normalized) {
    return false;
  }

  return BUILD_TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

interface CommandEvent {
  type: 'started' | 'completed';
  command: string;
}

/**
 * Executes prompts via the Codex CLI (OpenAI) as a child process.
 *
 * Codex CLI is invoked in non-interactive mode via:
 *   codex [global flags] exec --json "<prompt>"
 *
 * Output is streamed as JSONL events on stdout and plain-text warnings
 * on stderr. The CLI runs in the project working directory so it has
 * full codebase context.
 *
 * Key strength: deep codebase understanding, safe refactoring,
 * robust regression testing, incremental commits.
 */
export class CodexCliExecutor implements ModelExecutor {
  readonly engine = 'codex-cli' as const;
  private resolvedCodexPath: string | null | undefined;

  constructor(
    private readonly codexPath: string = 'codex',
    private readonly workDir: string = process.cwd(),
    private readonly mcpServers: Record<string, HelixMcpServerDefinition> = {},
    private workspaceContext?: WorkspaceExecutionContext,
  ) {}

  setWorkspaceContext(workspaceContext?: WorkspaceExecutionContext): void {
    this.workspaceContext = workspaceContext;
  }

  async execute(
    prompt: string,
    spec: ModelSpec,
    tools?: string[],
    onStream?: (event: StreamEvent) => void,
    outputSchema?: StageOutputSchemaConfig,
    timeoutMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<ExecutorResult> {
    const startTime = Date.now();
    const resolvedCodexPath = await this.resolveCodexPath();
    if (!resolvedCodexPath) {
      return {
        output: '',
        model: spec.model ?? 'gpt-5.5',
        engine: 'codex-cli',
        turnsUsed: 0,
        durationMs: Date.now() - startTime,
        error: `Codex CLI could not be found. Checked "${this.codexPath}" plus HELIX_CODEX_PATH/CODEX_CLI_PATH/CODEX_PATH, PATH entries, and common Codex install locations.`,
      };
    }

    const promptPlan = compactPromptForCodexLimit(this.buildPrompt(prompt, spec, tools));
    const effectivePrompt = promptPlan.prompt;
    const efficiencyController = new ExecutorEfficiencyController(spec.efficiencyBudget);
    const runDir = await mkdtemp(join(tmpdir(), 'helix-codex-'));
    const managedCodexHome = await prepareManagedCodexHome(runDir, spec.env);
    const outputFile = join(runDir, 'last-message.txt');
    const schemaFile = outputSchema ? join(runDir, 'output-schema.json') : null;

    if (schemaFile && outputSchema) {
      await writeFile(schemaFile, serializeStageOutputSchema(outputSchema), 'utf-8');
    }

    const args = this.buildArgs(spec, outputFile, schemaFile);

    onStream?.({
      type: 'progress',
      timestamp: new Date().toISOString(),
      message: `Spawning Codex exec${outputSchema ? ` (${outputSchema.id})` : ''}: ${resolvedCodexPath} ${args.join(' ').slice(0, 140)}...`,
    });

    if (promptPlan.compacted) {
      onStream?.({
        type: 'progress',
        timestamp: new Date().toISOString(),
        message: `Compacted Codex prompt from ${Math.ceil(promptPlan.originalBytes / 1024)} KiB to ${Math.ceil(promptPlan.finalBytes / 1024)} KiB to stay below the input limit`,
      });
    }

    return new Promise((resolvePromise) => {
      const errorChunks: string[] = [];
      const agentMessages: string[] = [];
      let bufferedStdout = '';
      let turnsUsed = 0;
      let timedOut = false;
      let timeoutMessage = '';
      let aborted = false;
      let abortMessage = '';
      let efficiencyStopped = false;
      let efficiencyMessage = '';
      let finalized = false;
      let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const sourceWorkspaceAliases = buildSourceWorkspaceAliases(this.workspaceContext);

      // ── Activity tracking for stall detection ──────────────────
      let lastActivityTime = Date.now();
      const activeCommands = new Map<string, number>();

      const finalize = async (code: number | null, spawnError?: string): Promise<void> => {
        if (finalized) {
          return;
        }
        finalized = true;

        try {
          if (bufferedStdout.trim()) {
            this.processStdoutChunk(
              `${bufferedStdout}\n`,
              agentMessages,
              handleObservedTurn,
              onStream,
            );
          }

          const fallbackOutput = await this.readOutputFile(outputFile);
          const output = selectFinalOutput(
            fallbackOutput,
            agentMessages,
            errorChunks.join('\n').trim(),
          );
          const errorOutput = errorChunks.join('\n');
          const durationMs = Date.now() - startTime;
          const finalizedTransportFailure =
            !spawnError &&
            !timedOut &&
            !aborted &&
            !efficiencyStopped &&
            turnsUsed === 0 &&
            code !== 0
              ? detectCodexTransportFailure(errorOutput)
              : undefined;
          const error =
            spawnError ??
            (timedOut
              ? timeoutMessage
              : aborted
                ? abortMessage
                : efficiencyStopped
                  ? efficiencyMessage
                  : (finalizedTransportFailure ??
                    (code !== 0 ? `Exit code ${code}: ${errorOutput.slice(0, 500)}` : undefined)));

          if (error && !timedOut && !aborted && !efficiencyStopped) {
            onStream?.({
              type: 'error',
              timestamp: new Date().toISOString(),
              message: `Codex exited with code ${code ?? 'unknown'}: ${(errorOutput || error).slice(0, 500)}`,
            });
          }

          resolvePromise({
            output,
            model: spec.model ?? 'gpt-5.5',
            engine: 'codex-cli',
            turnsUsed,
            durationMs,
            error,
            timedOut,
          });
        } finally {
          clearInterval(stallCheck);
          if (forceKillTimeout) {
            clearTimeout(forceKillTimeout);
          }
          if (abortListener && abortSignal) {
            abortSignal.removeEventListener('abort', abortListener);
          }
          await rm(runDir, { recursive: true, force: true });
        }
      };

      const child = spawn(resolvedCodexPath, args, {
        cwd: this.workDir,
        env: {
          ...process.env,
          ...spec.env,
          // Force non-interactive mode
          CI: 'true',
          CODEX_HOME: managedCodexHome,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const handleObservedTurn = (): void => {
        turnsUsed += 1;
        for (const message of efficiencyController.noteTurn(turnsUsed)) {
          onStream?.({
            type: 'progress',
            timestamp: new Date().toISOString(),
            message,
          });
        }
        const hardCapMessage = efficiencyController.getHardCapAbortMessage(turnsUsed, 'Codex');
        if (hardCapMessage && !timedOut && !aborted && !efficiencyStopped && !finalized) {
          efficiencyStopped = true;
          efficiencyMessage = hardCapMessage;
          child.kill('SIGTERM');
          onStream?.({
            type: 'error',
            timestamp: new Date().toISOString(),
            message: hardCapMessage,
          });
        }
      };

      child.stdout?.on('data', (data: Buffer) => {
        lastActivityTime = Date.now();
        const text = data.toString();
        bufferedStdout += text;
        const lines = bufferedStdout.split('\n');
        bufferedStdout = lines.pop() ?? '';

        for (const line of lines) {
          this.processJsonLine(line, agentMessages, handleObservedTurn, onStream, onCommandEvent);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        errorChunks.push(text);

        // Codex often writes progress to stderr
        for (const line of text.split('\n')) {
          if (line.trim()) {
            onStream?.({
              type: 'progress',
              timestamp: new Date().toISOString(),
              message: `[codex] ${line}`,
            });
          }
        }

        // Codex can emit transient websocket lookup noise before recovering via
        // HTTP. Do not kill it mid-startup; classify transport failure only if
        // the process later exits without producing a turn.
        if (CODEX_HTTP_FALLBACK_PATTERN.test(text)) {
          lastActivityTime = Date.now();
        }
      });

      child.on('close', (code) => {
        void finalize(code);
      });

      child.on('error', (err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onStream?.({
          type: 'error',
          timestamp: new Date().toISOString(),
          message: `Codex spawn error: ${errorMsg}`,
        });

        void finalize(null, errorMsg);
      });

      // Pipe the prompt via stdin to avoid ARG_MAX / E2BIG on macOS
      // when the assembled prompt (instruction docs + code map) exceeds
      // the ~256 KB execve argument limit.  Codex reads from stdin when
      // the positional prompt arg is '-'.
      child.stdin?.end(effectivePrompt);

      // Stall detection — kill Codex if no activity for stallThresholdMs.
      // Build/test commands count as activity (they produce command events).
      const stallThresholdMs = resolveInactivityStallThresholdMs(timeoutMs, spec.stallThresholdMs);

      const stallCheck = setInterval(() => {
        if (timedOut || aborted || finalized) return;
        if (activeCommands.size > 0) {
          return;
        }
        const silenceMs = Date.now() - lastActivityTime;
        if (silenceMs >= stallThresholdMs) {
          timedOut = true;
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          timeoutMessage = `Codex stalled after ${Math.ceil(silenceMs / 1000)}s of inactivity (${elapsed}s total elapsed, ${turnsUsed} turns)`;
          child.kill('SIGTERM');
          onStream?.({
            type: 'error',
            timestamp: new Date().toISOString(),
            message: timeoutMessage,
          });
        }
      }, STALL_CHECK_INTERVAL_MS);

      const onCommandEvent = (evt: CommandEvent): void => {
        if (timedOut || aborted || efficiencyStopped || finalized) return;
        lastActivityTime = Date.now();
        const buildOrTestCommand = isBuildOrTestCommand(evt.command);

        if (evt.type === 'started') {
          const sourceLeak = findSourceWorkspaceAliasInText(evt.command, sourceWorkspaceAliases);
          if (sourceLeak) {
            efficiencyStopped = true;
            efficiencyMessage = `HELIX workspace guard blocked Codex from accessing the source checkout path "${sourceLeak}". Continue from the replay worktree "${this.workDir}" instead.`;
            child.kill('SIGTERM');
            onStream?.({
              type: 'error',
              timestamp: new Date().toISOString(),
              message: efficiencyMessage,
            });
            return;
          }

          const decision = efficiencyController.evaluateShellCommand(
            evt.command,
            turnsUsed,
            buildOrTestCommand,
            Date.now() - startTime,
          );
          for (const warning of decision.warnings) {
            onStream?.({
              type: 'progress',
              timestamp: new Date().toISOString(),
              message: warning,
            });
          }
          if (decision.abortMessage) {
            efficiencyStopped = true;
            efficiencyMessage = decision.abortMessage;
            child.kill('SIGTERM');
            onStream?.({
              type: 'error',
              timestamp: new Date().toISOString(),
              message: decision.abortMessage,
            });
            return;
          }

          if (buildOrTestCommand) {
            activeCommands.set(evt.command, Date.now());
          }
          return;
        }

        // completed
        const cmdStartedAt = activeCommands.get(evt.command);
        if (cmdStartedAt == null) return;
        activeCommands.delete(evt.command);

        if (buildOrTestCommand) {
          const buildElapsedMs = Date.now() - cmdStartedAt;
          onStream?.({
            type: 'progress',
            timestamp: new Date().toISOString(),
            message: `Build/test completed: +${Math.ceil(buildElapsedMs / 1000)}s for \`${preview(evt.command, 80)}\``,
          });
        }
      };

      abortListener = () => {
        if (timedOut || aborted || finalized) {
          return;
        }

        aborted = true;
        abortMessage = 'Codex aborted by user';
        child.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          if (!finalized) {
            child.kill('SIGKILL');
          }
        }, 3_000);
        onStream?.({
          type: 'error',
          timestamp: new Date().toISOString(),
          message: abortMessage,
        });
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          abortListener();
        } else {
          abortSignal.addEventListener('abort', abortListener, { once: true });
        }
      }
    });
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveCodexPath()) !== null;
  }

  private async resolveCodexPath(): Promise<string | null> {
    if (this.resolvedCodexPath !== undefined) {
      return this.resolvedCodexPath;
    }

    this.resolvedCodexPath = await resolveCodexBinaryPath(this.codexPath);
    return this.resolvedCodexPath;
  }

  private buildArgs(spec: ModelSpec, outputFile: string, schemaFile: string | null): string[] {
    const args: string[] = [];

    args.push('-C', this.workDir);

    // Model selection
    if (spec.model) {
      args.push('--model', spec.model);
    }

    const reasoningEffort = mapReasoningEffort(spec.effort);
    if (reasoningEffort) {
      args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    }

    for (const [name, server] of Object.entries(this.mcpServers)) {
      args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`);
      if (server.args && server.args.length > 0) {
        args.push('-c', `mcp_servers.${name}.args=${formatTomlStringArray(server.args)}`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        args.push('-c', `mcp_servers.${name}.env=${formatTomlInlineTable(server.env)}`);
      }
    }

    if (this.workspaceContext?.mode === 'git-worktree') {
      args.push('--disable', 'plugins');
    }

    // Codex exec flags: sandbox and approval bypass are exec-level options
    args.push('exec', '--json', '--color', 'never', '--ephemeral', '-o', outputFile);

    const sandboxMode = resolveSandboxMode(spec.permissionMode);
    if (sandboxMode === 'danger-full-access') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--sandbox', sandboxMode);
    }

    if (schemaFile) {
      args.push('--output-schema', schemaFile);
    }

    // Read prompt from stdin to avoid ARG_MAX / E2BIG on large prompts
    args.push('-');

    return args;
  }

  private buildPrompt(prompt: string, spec: ModelSpec, tools?: string[]): string {
    const parts: string[] = [];

    if (spec.systemPrompt) {
      parts.push('## System Directive');
      parts.push(spec.systemPrompt);
    }

    if (tools && tools.length > 0) {
      parts.push('## Allowed Tools');
      parts.push(tools.join(', '));
    }

    parts.push(buildWorkspaceRules(spec.permissionMode));
    parts.push(prompt);
    return rewritePromptToExecutionWorkspace(
      parts.join('\n\n'),
      this.workDir,
      this.workspaceContext,
    );
  }

  private processStdoutChunk(
    chunk: string,
    agentMessages: string[],
    onTurn: () => void,
    onStream?: (event: StreamEvent) => void,
    onCommandEvent?: (event: CommandEvent) => void,
  ): void {
    for (const line of chunk.split('\n')) {
      this.processJsonLine(line, agentMessages, onTurn, onStream, onCommandEvent);
    }
  }

  private processJsonLine(
    line: string,
    agentMessages: string[],
    onTurn: () => void,
    onStream?: (event: StreamEvent) => void,
    onCommandEvent?: (event: CommandEvent) => void,
  ): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const event = tryParseCodexEvent(trimmed);
    if (!event) {
      onStream?.({
        type: 'progress',
        timestamp: new Date().toISOString(),
        message: `[codex] ${trimmed}`,
      });
      return;
    }

    if (event.type === 'item.started' || event.type === 'item.completed') {
      const item = event.item;
      if (!item?.type) {
        return;
      }

      if (item.type === 'agent_message' && item.text) {
        agentMessages.push(item.text);
        onTurn();
        onStream?.({
          type: 'output',
          timestamp: new Date().toISOString(),
          message: `[turn ${agentMessages.length}] ${preview(item.text)}`,
        });
        return;
      }

      if (item.type === 'command_execution') {
        const command = item.command ?? '(unknown command)';
        if (event.type === 'item.started') {
          onStream?.({
            type: 'tool-use',
            timestamp: new Date().toISOString(),
            message: `Bash: ${command}`,
            details: { tool: 'Bash', input: { command } },
          });
          onCommandEvent?.({ type: 'started', command });
          return;
        }

        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
        const noMatchSearch =
          exitCode === 1 && isNoMatchSearchCommand(command, item.aggregated_output ?? '');
        const suffix =
          exitCode == null ? 'completed' : noMatchSearch ? 'no matches' : `exit ${exitCode}`;
        onStream?.({
          type: exitCode === 0 || noMatchSearch ? 'progress' : 'error',
          timestamp: new Date().toISOString(),
          message: `Command ${suffix}: ${preview(item.aggregated_output ?? command, 160)}`,
        });
        onCommandEvent?.({ type: 'completed', command });
        return;
      }
    }

    if (event.type === 'turn.completed') {
      onStream?.({
        type: 'progress',
        timestamp: new Date().toISOString(),
        message: 'Codex turn completed',
      });
    }
  }

  private async readOutputFile(outputFile: string): Promise<string> {
    try {
      return (await readFile(outputFile, 'utf-8')).trim();
    } catch {
      return '';
    }
  }
}

/**
 * Resolves the Codex CLI binary path using the same candidate logic as
 * {@link CodexCliExecutor}. Returns the first executable candidate or `null`
 * if none is found.
 *
 * Exported so that `helix doctor` can perform a preflight check without
 * constructing a full executor instance.
 */
export async function resolveCodexBinaryPath(codexPath: string = 'codex'): Promise<string | null> {
  const candidates = buildCodexCandidatePaths(codexPath);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function buildCodexCandidatePaths(codexPath: string): string[] {
  const seen: string[] = [];
  const candidates: string[] = [];
  const addCandidate = (value: string | undefined): void => {
    if (!value) {
      return;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    if (looksLikePath(trimmed)) {
      const resolved = resolve(trimmed);
      if (!seen.includes(resolved)) {
        seen.push(resolved);
        candidates.push(resolved);
      }
      return;
    }

    for (const pathCandidate of expandBinaryFromPath(trimmed)) {
      if (!seen.includes(pathCandidate)) {
        seen.push(pathCandidate);
        candidates.push(pathCandidate);
      }
    }
  };

  addCandidate(codexPath);

  if (codexPath === 'codex') {
    for (const envKey of ['HELIX_CODEX_PATH', 'CODEX_CLI_PATH', 'CODEX_PATH']) {
      addCandidate(process.env[envKey]);
    }

    for (const commonPath of getCommonCodexInstallPaths()) {
      addCandidate(commonPath);
    }
  }

  return candidates;
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.startsWith('.');
}

function expandBinaryFromPath(binaryName: string): string[] {
  const pathValue = process.env.PATH ?? '';
  if (!pathValue) {
    return [];
  }

  const entries = pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.map((entry) => resolve(entry, binaryName));
}

function getCommonCodexInstallPaths(): string[] {
  return [
    '/Applications/Codex.app/Contents/Resources/codex',
    join(homedir(), 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    join(homedir(), '.local', 'bin', 'codex'),
    join(homedir(), '.npm-global', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
}

async function prepareManagedCodexHome(
  runDir: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  const managedCodexHome = join(runDir, 'codex-home');
  const sourceCodexHome = resolveSeedCodexHome(env);

  await mkdir(managedCodexHome, { recursive: true });
  await mkdir(join(managedCodexHome, 'sessions'), { recursive: true });
  await mkdir(join(managedCodexHome, 'shell_snapshots'), { recursive: true });

  await seedCodexHomeFiles(sourceCodexHome, managedCodexHome);

  return managedCodexHome;
}

function resolveSeedCodexHome(env: NodeJS.ProcessEnv | undefined): string {
  const explicitCodexHome = env?.CODEX_HOME?.trim();
  if (explicitCodexHome) {
    return resolve(explicitCodexHome);
  }

  const inheritedCodexHome = process.env.CODEX_HOME?.trim();
  if (inheritedCodexHome) {
    return resolve(inheritedCodexHome);
  }

  return join(homedir(), '.codex');
}

async function seedCodexHomeFiles(
  sourceCodexHome: string,
  managedCodexHome: string,
): Promise<void> {
  for (const filename of CODEX_HOME_SEED_FILENAMES) {
    try {
      const contents = await readFile(join(sourceCodexHome, filename));
      await writeFile(join(managedCodexHome, filename), contents);
    } catch {
      // Missing local Codex auth/config should not block HELIX from using
      // a writable temp CODEX_HOME for providers that authenticate differently.
    }
  }
}

export function resolveExecutionTimeoutMs(
  timeoutMs: number | undefined,
  maxTurns: number | undefined,
): number {
  if (timeoutMs != null && timeoutMs > 0) {
    return timeoutMs;
  }

  if (maxTurns != null && maxTurns > 0) {
    return maxTurns * 60_000; // rough estimate: 1 min per turn
  }

  return 30 * 60_000;
}

export function resolveInactivityStallThresholdMs(
  timeoutMs: number | undefined,
  stallThresholdMs?: number,
): number {
  if (stallThresholdMs != null && stallThresholdMs > 0) {
    return timeoutMs != null && timeoutMs > 0
      ? Math.min(timeoutMs, stallThresholdMs)
      : stallThresholdMs;
  }

  if (timeoutMs != null && timeoutMs > 0) {
    return Math.min(timeoutMs, DEFAULT_STALL_THRESHOLD_MS);
  }

  return DEFAULT_STALL_THRESHOLD_MS;
}

function mapReasoningEffort(
  effort: ModelSpec['effort'],
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'extra-high':
      return 'xhigh';
    default:
      return undefined;
  }
}

function formatTomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(',')}]`;
}

function formatTomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(', ')} }`;
}

function buildWorkspaceRules(permissionMode: ModelSpec['permissionMode']): string {
  const writeGuidance =
    permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions'
      ? '- Edit files directly inside the current workspace when you need to make changes.'
      : '- This run is read-only. Do not attempt file writes or shell workarounds for writing; describe the exact changes instead.';

  return [
    '## Workspace Rules',
    writeGuidance,
    '- Prefer direct workspace edits over shell-generated patch workflows.',
    '- Do not use heredocs (`<<EOF`), temporary files, or patch files outside the repository to create or edit content.',
    '- Never write outside the current workspace, including `/tmp`, home-directory dotfiles, or generated patch files, unless the task explicitly requires it.',
    '- Prefer narrow package-local build and test commands over repo-wide report or aggregate scripts.',
    '- Keep shell commands non-interactive, workspace-relative, and as simple as possible.',
    '- Avoid starting background services, watchers, or long-lived processes unless the task explicitly requires them.',
    '- If a write or command is blocked by permissions, report the exact intended change instead of retrying with a different shell workaround.',
  ].join('\n');
}

function resolveSandboxMode(permissionMode: ModelSpec['permissionMode']): string {
  switch (permissionMode) {
    case 'acceptEdits':
      return 'workspace-write';
    case 'bypassPermissions':
      return 'danger-full-access';
    case 'default':
    default:
      return 'read-only';
  }
}

function rewritePromptToExecutionWorkspace(
  prompt: string,
  workDir: string,
  workspaceContext?: WorkspaceExecutionContext,
): string {
  return rewriteTextToExecutionWorkspace(prompt, workDir, workspaceContext);
}

interface CodexExecEvent {
  type: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
  };
}

function tryParseCodexEvent(line: string): CodexExecEvent | null {
  try {
    return JSON.parse(line) as CodexExecEvent;
  } catch {
    return null;
  }
}

function preview(text: string, maxLength: number = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function selectFinalOutput(
  outputFileContent: string,
  agentMessages: string[],
  errorOutput: string,
): string {
  const normalizedOutputFile = outputFileContent.trim();
  if (normalizedOutputFile) {
    return normalizedOutputFile;
  }

  for (let index = agentMessages.length - 1; index >= 0; index--) {
    const candidate = agentMessages[index]?.trim();
    if (candidate) {
      return candidate;
    }
  }

  return errorOutput;
}

export function detectCodexTransportFailure(errorOutput: string): string | undefined {
  if (!errorOutput) {
    return undefined;
  }

  const lookupFailure = CODEX_TRANSPORT_LOOKUP_PATTERNS.some((pattern) =>
    pattern.test(errorOutput),
  );
  if (!lookupFailure) {
    return undefined;
  }

  if (/api\.openai\.com|responses_websocket|falling back to HTTP/i.test(errorOutput)) {
    return 'Codex model transport unavailable: Codex could not complete its startup connection to api.openai.com (websocket/HTTP handoff). Retry the stage; if it persists, verify provider or network access.';
  }

  return 'Codex model transport unavailable: Codex could not complete its startup connection to the model endpoint. Retry the stage; if it persists, verify provider or network access.';
}

function compactPromptForCodexLimit(prompt: string): {
  prompt: string;
  compacted: boolean;
  originalBytes: number;
  finalBytes: number;
} {
  const originalBytes = utf8Bytes(prompt);
  if (originalBytes <= CODEX_PROMPT_SOFT_LIMIT_BYTES) {
    return {
      prompt,
      compacted: false,
      originalBytes,
      finalBytes: originalBytes,
    };
  }

  let compactedPrompt = prompt;

  for (const phase of ['preferredBytes', 'minimumBytes'] as const) {
    for (const budget of CODEX_SECTION_BUDGETS) {
      compactedPrompt = compactMarkdownSection(
        compactedPrompt,
        budget.heading,
        budget[phase],
        CODEX_SECTION_COMPACTION_NOTE,
      );

      if (utf8Bytes(compactedPrompt) <= CODEX_PROMPT_TARGET_BYTES) {
        const finalBytes = utf8Bytes(compactedPrompt);
        return {
          prompt: compactedPrompt,
          compacted: finalBytes < originalBytes,
          originalBytes,
          finalBytes,
        };
      }
    }
  }

  compactedPrompt = hardTrimPrompt(compactedPrompt, CODEX_PROMPT_TARGET_BYTES);
  const finalBytes = utf8Bytes(compactedPrompt);

  return {
    prompt: compactedPrompt,
    compacted: finalBytes < originalBytes,
    originalBytes,
    finalBytes,
  };
}

function compactMarkdownSection(
  prompt: string,
  heading: string,
  maxBytes: number,
  notice: string,
): string {
  const section = findMarkdownSection(prompt, heading);
  if (!section) {
    return prompt;
  }

  if (utf8Bytes(section.fullText) <= maxBytes) {
    return prompt;
  }

  const availableContentBytes = Math.max(maxBytes - utf8Bytes(section.headingLine) - 1, 256);
  const compactedContent = truncateUtf8WithNotice(
    section.content.trim(),
    availableContentBytes,
    notice,
  );
  const replacement = `${section.headingLine}\n${compactedContent}`;
  return `${prompt.slice(0, section.start)}${replacement}${prompt.slice(section.end)}`;
}

function hardTrimPrompt(prompt: string, maxBytes: number): string {
  const structuredOutputHeading = '\n## Structured Output Contract';
  const structuredOutputIndex = prompt.lastIndexOf(structuredOutputHeading);
  const body =
    structuredOutputIndex >= 0
      ? prompt.slice(0, structuredOutputIndex).trimEnd()
      : prompt.trimEnd();
  const structuredTail =
    structuredOutputIndex >= 0 ? prompt.slice(structuredOutputIndex).trimStart() : '';

  const reserveForTail = structuredTail ? utf8Bytes(structuredTail) + 2 : 0;
  const reserveForNote = utf8Bytes(CODEX_FINAL_COMPACTION_NOTE) + 2;
  const bodyBudget = Math.max(maxBytes - reserveForTail - reserveForNote, 8_000);
  const compactedBody = truncateUtf8Middle(
    body,
    bodyBudget,
    '\n...\n[HELIX compacted omitted middle content]\n...\n',
  );

  return [compactedBody, CODEX_FINAL_COMPACTION_NOTE, structuredTail]
    .filter((value) => value && value.trim().length > 0)
    .join('\n\n');
}

function findMarkdownSection(
  prompt: string,
  heading: string,
): {
  start: number;
  end: number;
  headingLine: string;
  content: string;
  fullText: string;
} | null {
  const headingIndex = prompt.indexOf(`${heading}\n`);
  const start = headingIndex >= 0 ? headingIndex : prompt.startsWith(heading) ? 0 : -1;
  if (start < 0) {
    return null;
  }

  const headingLineEnd = prompt.indexOf('\n', start);
  if (headingLineEnd < 0) {
    return null;
  }

  const contentStart = headingLineEnd + 1;
  const nextSection = prompt.indexOf('\n## ', contentStart);
  const end = nextSection >= 0 ? nextSection : prompt.length;
  return {
    start,
    end,
    headingLine: prompt.slice(start, headingLineEnd),
    content: prompt.slice(contentStart, end),
    fullText: prompt.slice(start, end),
  };
}

function truncateUtf8WithNotice(content: string, maxBytes: number, notice: string): string {
  if (utf8Bytes(content) <= maxBytes) {
    return content;
  }

  const trimmedNotice = notice.trimStart();
  const noticeBytes = utf8Bytes(trimmedNotice);
  if (noticeBytes >= maxBytes) {
    return truncateUtf8(trimmedNotice, maxBytes);
  }

  return `${truncateUtf8(content, Math.max(maxBytes - noticeBytes - 1, 0)).trimEnd()}\n${trimmedNotice}`;
}

function truncateUtf8Middle(content: string, maxBytes: number, marker: string): string {
  if (utf8Bytes(content) <= maxBytes) {
    return content;
  }

  const markerBytes = utf8Bytes(marker);
  if (markerBytes >= maxBytes) {
    return truncateUtf8(marker, maxBytes);
  }

  const available = maxBytes - markerBytes;
  const headBudget = Math.max(Math.floor(available * 0.7), 1);
  const tailBudget = Math.max(available - headBudget, 1);
  const head = truncateUtf8(content, headBudget).trimEnd();
  const tail = truncateUtf8FromEnd(content, tailBudget).trimStart();
  return `${head}${marker}${tail}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  if (utf8Bytes(value) <= maxBytes) {
    return value;
  }

  let low = 0;
  let high = value.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return value.slice(0, low);
}

function truncateUtf8FromEnd(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  if (utf8Bytes(value) <= maxBytes) {
    return value;
  }

  let low = 0;
  let high = value.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(value.length - mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return value.slice(value.length - low);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeShellCommand(command: string): string | undefined {
  let normalized = command.trim();
  if (!normalized) {
    return undefined;
  }

  normalized = normalized.replace(SHELL_WRAPPER_RE, '');
  const quoteMatch = normalized.match(SHELL_QUOTE_RE);
  if (quoteMatch) {
    normalized = quoteMatch[2];
  }

  normalized = normalized.trim();
  normalized = normalized.replace(LEADING_ENV_VARS_RE, '').trim();
  return normalized || undefined;
}

function isNoMatchSearchCommand(command: string, aggregatedOutput: string): boolean {
  if (aggregatedOutput.trim().length > 0) {
    return false;
  }

  const normalized = normalizeShellCommand(command);
  if (!normalized) {
    return false;
  }

  return NO_MATCH_SEARCH_COMMAND_RE.test(normalized);
}
