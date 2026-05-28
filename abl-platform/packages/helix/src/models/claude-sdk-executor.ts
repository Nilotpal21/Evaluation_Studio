import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

import type { Options as ClaudeSdkOptions } from '@anthropic-ai/claude-agent-sdk';

import { ExecutorEfficiencyController } from './executor-efficiency-controller.js';
import { buildSchemaRepairPrompt, checkStructuredOutput } from './structured-output-repair.js';
import { buildStageOutputInstructions } from '../pipeline/stage-output-schema.js';
import {
  buildSourceWorkspaceAliases,
  buildWorkspacePathReplacements,
  rewriteTextToExecutionWorkspace,
  shouldGuardWorkspacePaths,
  type WorkspacePathReplacement,
} from './workspace-grounding.js';
import type {
  ClaudeSettingSource,
  ExecutorResult,
  HelixMcpServerDefinition,
  ModelExecutor,
  ModelSpec,
  StageOutputSchemaConfig,
  StreamEvent,
  WorkspaceExecutionContext,
} from '../types.js';

/**
 * Default stall threshold: if no activity (tool use, text output, tool
 * result) is observed for this long, the agent is considered stalled and
 * killed.  This replaces the old hard timeout approach — agents are free
 * to run as long as they're making progress.
 */
const DEFAULT_STALL_THRESHOLD_MS = 10 * 60_000; // 10 minutes

/**
 * Executes prompts via the Claude Code Agent SDK.
 *
 * Uses the `query()` function from @anthropic-ai/claude-agent-sdk
 * which returns an async iterable of streaming messages.
 *
 * SDK message format (discovered empirically):
 * - type=assistant: msg.message.content[] has blocks: thinking, text, tool_use
 * - type=system subtype=init: session initialization
 * - type=system subtype=task_started: agent spawned a sub-task (desc field)
 * - type=system subtype=task_progress: sub-task progress (desc field)
 * - type=system subtype=task_completed: sub-task finished (desc field)
 * - type=user: tool results fed back (msg.message.content[] has tool_result blocks)
 * - type=result: final output in msg.result
 */
export class ClaudeSdkExecutor implements ModelExecutor {
  readonly engine = 'claude-code' as const;

  constructor(
    private readonly workDir: string = process.cwd(),
    private readonly settingSources: ClaudeSettingSource[] = [],
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
    const effectivePrompt = rewriteTextToExecutionWorkspace(
      applyOutputSchemaPrompt(prompt, outputSchema),
      this.workDir,
      this.workspaceContext,
    );
    const efficiencyController = new ExecutorEfficiencyController(spec.efficiencyBudget);
    let turnsUsed = 0;
    let costUsd = 0;
    let finalOutput = '';
    const contentChunks: string[] = [];
    const abortController = new AbortController();
    const stallThresholdMs =
      spec.stallThresholdMs != null && spec.stallThresholdMs > 0
        ? timeoutMs != null && timeoutMs > 0
          ? Math.min(timeoutMs, spec.stallThresholdMs)
          : spec.stallThresholdMs
        : timeoutMs != null && timeoutMs > 0
          ? Math.min(timeoutMs, DEFAULT_STALL_THRESHOLD_MS)
          : DEFAULT_STALL_THRESHOLD_MS;
    let abortReason = 'Claude aborted by user';
    let stalled = false;
    let aborted = false;
    let stream: (AsyncIterable<unknown> & { close(): void }) | undefined;
    let abortListener: (() => void) | undefined;

    // Heartbeat — emit a pulse every 10s so the user knows it's alive,
    // and kill the agent if it stalls (no activity for stallThresholdMs).
    let lastActivityTime = Date.now();
    const heartbeat = setInterval(() => {
      const silenceMs = Date.now() - lastActivityTime;
      if (silenceMs >= stallThresholdMs) {
        stalled = true;
        abortController.abort();
        stream?.close();
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        onStream?.({
          type: 'error',
          timestamp: new Date().toISOString(),
          message: `Claude stalled after ${Math.ceil(silenceMs / 1000)}s of inactivity (${elapsed}s total elapsed, ${turnsUsed} turns)`,
        });
      } else if (silenceMs > 10_000) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        onStream?.({
          type: 'progress',
          timestamp: new Date().toISOString(),
          message: `... agent working (${elapsed}s elapsed, ${turnsUsed} turns)`,
        });
      }
    }, 10_000);

    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const options: ClaudeSdkOptions = {
        model: spec.model ?? 'opus',
        maxTurns: efficiencyController.resolveMaxTurns(spec.maxTurns) ?? 50,
        permissionMode: spec.permissionMode ?? 'default',
        cwd: this.workDir,
        abortController,
      };

      if (spec.effort) {
        options['effort'] = mapHelixEffortToSdkEffort(spec.effort);
      }

      if (this.settingSources.length > 0) {
        options['settingSources'] = [...this.settingSources];
      }
      const workspaceHooks = buildWorkspaceRewriteHooks(this.workDir, this.workspaceContext);
      if (workspaceHooks) {
        options['hooks'] = workspaceHooks;
      }
      const allowedToolsGuard = buildAllowedToolsGuard(tools);
      const workspaceGuard = buildWorkspaceToolGuard(this.workDir, this.workspaceContext);
      const efficiencyGuard = buildEfficiencyToolGuard(efficiencyController, () => turnsUsed);
      const toolGuard = composeToolGuards(allowedToolsGuard, workspaceGuard, efficiencyGuard);
      if (toolGuard) {
        options['canUseTool'] = toolGuard;
      }
      if (Object.keys(this.mcpServers).length > 0) {
        options['mcpServers'] = Object.fromEntries(
          Object.entries(this.mcpServers).map(([name, server]) => [
            name,
            {
              type: 'stdio',
              command: server.command,
              ...(server.args ? { args: [...server.args] } : {}),
              ...(server.env ? { env: { ...server.env } } : {}),
            },
          ]),
        );
      }
      if (spec.maxBudgetUsd != null) {
        options['maxBudgetUsd'] = spec.maxBudgetUsd;
      }
      if (spec.systemPrompt) {
        options['systemPrompt'] = spec.systemPrompt;
      }
      if (tools) {
        options['allowedTools'] = [...tools];
      }
      if (spec.env) {
        options['env'] = { ...process.env, ...spec.env };
      }

      stream = query({ prompt: effectivePrompt, options });

      abortListener = () => {
        if (stalled || aborted) {
          return;
        }

        aborted = true;
        abortController.abort();
        stream?.close();
        onStream?.({
          type: 'error',
          timestamp: new Date().toISOString(),
          message: abortReason,
        });
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          abortListener();
        } else {
          abortSignal.addEventListener('abort', abortListener, { once: true });
        }
      }

      for await (const message of stream) {
        const msg = message as Record<string, unknown>;
        const msgType = msg['type'] as string | undefined;
        let observedActivity = false;

        // ── Assistant messages: content is in msg.message.content[] ──
        if (msgType === 'assistant') {
          turnsUsed++;
          observedActivity = true;
          for (const message of efficiencyController.noteTurn(turnsUsed)) {
            onStream?.({
              type: 'progress',
              timestamp: new Date().toISOString(),
              message,
            });
          }
          const hardCapMessage = efficiencyController.getHardCapAbortMessage(turnsUsed, 'Claude');
          if (hardCapMessage && !stalled && !aborted) {
            aborted = true;
            abortReason = hardCapMessage;
            abortController.abort();
            stream?.close();
            onStream?.({
              type: 'error',
              timestamp: new Date().toISOString(),
              message: hardCapMessage,
            });
            break;
          }
          const innerMsg = msg['message'] as Record<string, unknown> | undefined;
          const contentBlocks = getContentBlocks(innerMsg);

          let hasText = false;
          let hasToolUse = false;

          for (const block of contentBlocks) {
            const blockType = block['type'] as string;

            if (blockType === 'tool_use') {
              hasToolUse = true;
              const toolName = (block['name'] as string) || 'unknown';
              const toolInput = block['input'] as Record<string, unknown> | undefined;
              onStream?.({
                type: 'tool-use',
                timestamp: new Date().toISOString(),
                message: formatToolDetail(toolName, toolInput),
                details: { tool: toolName, input: toolInput },
              });
            }

            if (blockType === 'text') {
              const text = block['text'] as string;
              if (text) {
                hasText = true;
                contentChunks.push(text);
                const preview = text.slice(0, 200).replace(/\n/g, ' ');
                onStream?.({
                  type: 'output',
                  timestamp: new Date().toISOString(),
                  message: `[turn ${turnsUsed}] ${preview}${text.length > 200 ? '...' : ''}`,
                });
              }
            }
          }

          // Show thinking only if no text and no tool use
          if (!hasText && !hasToolUse) {
            onStream?.({
              type: 'progress',
              timestamp: new Date().toISOString(),
              message: `[turn ${turnsUsed}] thinking...`,
            });
          }
        }

        // ── System messages: task_started, task_progress ──
        if (msgType === 'system') {
          const subtype = msg['subtype'] as string | undefined;
          const desc = msg['description'] as string | undefined;

          if (subtype === 'task_started' && desc) {
            observedActivity = true;
            onStream?.({
              type: 'tool-use',
              timestamp: new Date().toISOString(),
              message: `Agent: ${desc}`,
              details: { tool: 'Agent', input: { description: desc } },
            });
          }

          if (subtype === 'task_progress' && desc) {
            observedActivity = true;
            onStream?.({
              type: 'progress',
              timestamp: new Date().toISOString(),
              message: `  ⤷ ${desc}`,
            });
          }

          if (subtype === 'task_completed' && desc) {
            observedActivity = true;
            onStream?.({
              type: 'progress',
              timestamp: new Date().toISOString(),
              message: `  ✓ ${desc}`,
            });
          }
        }

        // ── User messages (tool results from SDK) ──
        if (msgType === 'user') {
          const innerMsg = msg['message'] as Record<string, unknown> | undefined;
          const contentBlocks = getContentBlocks(innerMsg);
          for (const block of contentBlocks) {
            if (block['type'] === 'tool_result') {
              observedActivity = true;
              const resultContent = block['content'] || '';
              const resultStr =
                typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent);
              const lines = resultStr.split('\n').length;
              onStream?.({
                type: 'progress',
                timestamp: new Date().toISOString(),
                message: `  ← ${lines} lines`,
              });
            }
          }
        }

        // ── Final result ──
        if (msgType === 'result' || 'result' in msg) {
          observedActivity = true;
          const result = msg['result'] as string;
          if (result) finalOutput = result;
          // Claude SDK may report cost in the result event
          const msgCost = msg['costUsd'] ?? msg['cost_usd'] ?? msg['total_cost_usd'];
          if (typeof msgCost === 'number') {
            costUsd = msgCost;
          }
        }

        if (observedActivity) {
          lastActivityTime = Date.now();
        }
      }

      if (!finalOutput && contentChunks.length > 0) {
        finalOutput = contentChunks.join('\n');
      }

      if (aborted) {
        return {
          output: finalOutput || '(no output captured)',
          model: spec.model ?? 'opus',
          engine: 'claude-code',
          turnsUsed,
          durationMs: Date.now() - startTime,
          costUsd: costUsd || undefined,
          error: abortReason,
        };
      }

      if (stalled) {
        const stalledMsg = `Claude stalled after ${Math.ceil((Date.now() - lastActivityTime) / 1000)}s of inactivity`;
        return {
          output: finalOutput || '(no output captured)',
          model: spec.model ?? 'opus',
          engine: 'claude-code',
          turnsUsed,
          durationMs: Date.now() - startTime,
          costUsd: costUsd || undefined,
          error: stalledMsg,
          timedOut: true,
        };
      }

      if (outputSchema && finalOutput) {
        const check = checkStructuredOutput(finalOutput, outputSchema);
        if (check.malformed) {
          const repairPrompt = buildSchemaRepairPrompt(
            finalOutput,
            outputSchema,
            check.errorMessage,
            check.errorDetails,
          );
          onStream?.({
            type: 'progress',
            timestamp: new Date().toISOString(),
            message: `Claude output failed ${outputSchema.id} schema — issuing repair turn (${check.errorMessage ?? 'malformed'})`,
          });
          const repairSpec: ModelSpec = {
            ...spec,
            maxTurns: 3,
            efficiencyBudget: {
              targetTurns: 1,
              explorationTurns: 0,
              hardTurnCap: 3,
              disableToolUse: true,
            },
          };
          const repairResult = await this.execute(
            repairPrompt,
            repairSpec,
            [],
            onStream,
            undefined,
            timeoutMs,
            abortSignal,
          );
          const aggregatedTurns = turnsUsed + (repairResult.turnsUsed ?? 0);
          const aggregatedCost = (costUsd || 0) + (repairResult.costUsd ?? 0);
          const aggregatedDuration = Date.now() - startTime;
          if (repairResult.error) {
            return {
              output: finalOutput,
              model: spec.model ?? 'opus',
              engine: 'claude-code',
              turnsUsed: aggregatedTurns,
              durationMs: aggregatedDuration,
              costUsd: aggregatedCost || undefined,
              error: `structured-output repair failed: ${repairResult.error}`,
              timedOut: repairResult.timedOut,
            };
          }
          const repairedCheck = checkStructuredOutput(repairResult.output, outputSchema);
          if (repairedCheck.malformed) {
            return {
              output: repairResult.output,
              model: spec.model ?? 'opus',
              engine: 'claude-code',
              turnsUsed: aggregatedTurns,
              durationMs: aggregatedDuration,
              costUsd: aggregatedCost || undefined,
              error: `structured-output repair failed: ${repairedCheck.errorMessage ?? 'schema validation failed after repair turn'}`,
            };
          }
          return {
            output: repairResult.output,
            model: spec.model ?? 'opus',
            engine: 'claude-code',
            turnsUsed: aggregatedTurns,
            durationMs: aggregatedDuration,
            costUsd: aggregatedCost || undefined,
          };
        }
      }

      return {
        output: finalOutput,
        model: spec.model ?? 'opus',
        engine: 'claude-code',
        turnsUsed,
        durationMs: Date.now() - startTime,
        costUsd: costUsd || undefined,
      };
    } catch (err) {
      const errorMsg = aborted
        ? abortReason
        : stalled
          ? `Claude stalled after inactivity`
          : err instanceof Error
            ? err.message
            : String(err);
      if (!stalled && !aborted) {
        onStream?.({
          type: 'error',
          timestamp: new Date().toISOString(),
          message: `Claude SDK error: ${errorMsg}`,
        });
      }

      return {
        output: finalOutput || contentChunks.join('\n') || '(no output captured)',
        model: spec.model ?? 'opus',
        engine: 'claude-code',
        turnsUsed,
        durationMs: Date.now() - startTime,
        costUsd: costUsd || undefined,
        error: errorMsg,
        timedOut: stalled,
      };
    } finally {
      if (abortListener && abortSignal) {
        abortSignal.removeEventListener('abort', abortListener);
      }
      clearInterval(heartbeat);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import('@anthropic-ai/claude-agent-sdk');
      return true;
    } catch {
      return false;
    }
  }
}

function applyOutputSchemaPrompt(prompt: string, outputSchema?: StageOutputSchemaConfig): string {
  if (!outputSchema || prompt.includes('## Structured Output Contract')) {
    return prompt;
  }

  return `${prompt}\n\n${buildStageOutputInstructions(outputSchema)}`;
}

/**
 * Safely extract content blocks from the inner message object.
 * SDK format: msg.message = { role, content: [...blocks] }
 */
function getContentBlocks(
  innerMsg: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  if (!innerMsg) return [];
  const content = innerMsg['content'];
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
  return [];
}

/**
 * Format a tool call into a human-readable one-liner.
 */
function formatToolDetail(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string {
  if (!toolInput) return toolName;

  // Show the most useful parameter for each tool type
  const path = toolInput['file_path'] || toolInput['path'] || toolInput['pattern'];
  const cmd = toolInput['command'];
  const query = toolInput['query'] || toolInput['prompt'];

  if (path) return `${toolName}: ${path}`;
  if (cmd) {
    const cmdStr = String(cmd);
    return `${toolName}: ${cmdStr.slice(0, 80)}${cmdStr.length > 80 ? '...' : ''}`;
  }
  if (query) {
    const qStr = String(query);
    return `${toolName}: "${qStr.slice(0, 60)}${qStr.length > 60 ? '...' : ''}"`;
  }
  return toolName;
}

const WORKSPACE_GUARDED_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
]);

const WORKSPACE_PATH_KEYS = new Set([
  'file_path',
  'path',
  'paths',
  'directory',
  'dir',
  'cwd',
  'root',
]);
const WORKSPACE_PATTERN_KEYS = new Set(['pattern']);
const WORKSPACE_COMMAND_KEYS = new Set(['command', 'cmd', 'commands']);

type ClaudeToolGuard = NonNullable<ClaudeSdkOptions['canUseTool']>;

function buildAllowedToolsGuard(tools?: string[]): ClaudeToolGuard | undefined {
  if (!tools) {
    return undefined;
  }

  const allowedTools = new Set(tools);
  return async (toolName) => {
    if (allowedTools.has(toolName)) {
      return { behavior: 'allow' };
    }

    return {
      behavior: 'deny',
      message:
        allowedTools.size === 0
          ? 'HELIX disabled tool use for this review. Synthesize the result from the retained evidence instead of opening tools.'
          : `HELIX blocked ${toolName} for this review. Allowed tools: ${[...allowedTools].join(', ')}`,
    };
  };
}

function buildWorkspaceRewriteHooks(
  workDir: string,
  workspaceContext?: WorkspaceExecutionContext,
): ClaudeSdkOptions['hooks'] | undefined {
  if (shouldGuardWorkspacePaths(workspaceContext)) {
    return undefined;
  }

  const replacements = buildWorkspacePathReplacements(workDir, workspaceContext);
  if (replacements.length === 0) {
    return undefined;
  }

  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (
              input.hook_event_name !== 'PreToolUse' ||
              !WORKSPACE_GUARDED_TOOLS.has(input.tool_name) ||
              !isRecord(input.tool_input)
            ) {
              return { continue: true };
            }

            const rewrittenInput = rewriteWorkspaceToolInput(input.tool_input, replacements);
            if (!rewrittenInput) {
              return { continue: true };
            }

            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput: rewrittenInput,
                additionalContext: `HELIX remapped source-checkout paths into the execution workspace ${workDir}. Keep every file read rooted there.`,
              },
            };
          },
        ],
      },
    ],
  };
}

function buildWorkspaceToolGuard(
  workDir: string,
  workspaceContext?: WorkspaceExecutionContext,
): ClaudeToolGuard | undefined {
  const normalizedWorkDir = normalize(resolve(workDir));
  const sourceAliases = buildSourceWorkspaceAliases(workspaceContext);

  if (sourceAliases.length === 0 && !shouldGuardWorkspacePaths(workspaceContext)) {
    return undefined;
  }

  return async (toolName, input) => {
    if (!WORKSPACE_GUARDED_TOOLS.has(toolName)) {
      return { behavior: 'allow' };
    }

    const sourceLeak = findSourceWorkspaceReference(toolName, input, sourceAliases);
    if (sourceLeak) {
      return {
        behavior: 'deny',
        message: `HELIX workspace guard blocked ${toolName} from reading the source checkout path "${sourceLeak}". Re-run the tool from the execution workspace "${workDir}" instead.`,
      };
    }

    const outsideWorkspace = findOutOfWorkspacePath(toolName, input, normalizedWorkDir);
    if (outsideWorkspace) {
      return {
        behavior: 'deny',
        message: `HELIX workspace guard blocked ${toolName} from accessing "${outsideWorkspace}" outside the execution workspace "${workDir}". Use a path rooted in the current worktree.`,
      };
    }

    return { behavior: 'allow' };
  };
}

function buildEfficiencyToolGuard(
  controller: ExecutorEfficiencyController,
  getTurnsUsed: () => number,
): ClaudeToolGuard | undefined {
  if (!controller.isEnabled) {
    return undefined;
  }

  return async (toolName, input) => controller.evaluateToolUse(toolName, input, getTurnsUsed());
}

function composeToolGuards(
  ...guards: Array<ClaudeToolGuard | undefined>
): ClaudeToolGuard | undefined {
  const activeGuards = guards.filter((guard): guard is ClaudeToolGuard => guard != null);
  if (activeGuards.length === 0) {
    return undefined;
  }

  return async (toolName, input, options) => {
    for (const guard of activeGuards) {
      const result = await guard(toolName, input, options);
      if (result.behavior === 'deny') {
        return result;
      }
    }

    return { behavior: 'allow' };
  };
}

function rewriteWorkspaceToolInput(
  input: Record<string, unknown>,
  replacements: WorkspacePathReplacement[],
): Record<string, unknown> | undefined {
  const [rewritten, changed] = rewriteWorkspaceValue(input, replacements);
  return changed && isRecord(rewritten) ? rewritten : undefined;
}

function rewriteWorkspaceValue(
  value: unknown,
  replacements: WorkspacePathReplacement[],
): [unknown, boolean] {
  if (typeof value === 'string') {
    let nextValue = value;
    let changed = false;
    for (const replacement of replacements) {
      if (!nextValue.includes(replacement.from)) {
        continue;
      }

      nextValue = nextValue.split(replacement.from).join(replacement.to);
      changed = true;
    }

    return [nextValue, changed];
  }

  if (Array.isArray(value)) {
    let changed = false;
    const nextArray = value.map((entry) => {
      const [rewrittenEntry, entryChanged] = rewriteWorkspaceValue(entry, replacements);
      changed ||= entryChanged;
      return rewrittenEntry;
    });
    return [nextArray, changed];
  }

  if (isRecord(value)) {
    let changed = false;
    const nextRecord: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const [rewrittenEntry, entryChanged] = rewriteWorkspaceValue(entry, replacements);
      changed ||= entryChanged;
      nextRecord[key] = rewrittenEntry;
    }
    return [nextRecord, changed];
  }

  return [value, false];
}

function findSourceWorkspaceReference(
  toolName: string,
  input: Record<string, unknown>,
  sourceAliases: string[],
): string | undefined {
  if (sourceAliases.length === 0) {
    return undefined;
  }

  if (toolName === 'Bash') {
    for (const command of collectCommandCandidates(input)) {
      const alias = sourceAliases.find((candidate) => command.includes(candidate));
      if (alias) {
        return alias;
      }
    }
  }

  for (const candidate of collectPathCandidates(toolName, input)) {
    const alias = sourceAliases.find((prefix) => candidate.includes(prefix));
    if (alias) {
      return alias;
    }
  }

  return undefined;
}

function findOutOfWorkspacePath(
  toolName: string,
  input: Record<string, unknown>,
  workDir: string,
): string | undefined {
  if (toolName === 'Bash') {
    return undefined;
  }

  for (const candidate of collectPathCandidates(toolName, input)) {
    const resolvedPath = resolveToolPathCandidate(candidate, workDir);
    if (!resolvedPath) {
      continue;
    }

    if (!isPathWithinRoot(resolvedPath, workDir)) {
      return candidate;
    }
  }

  return undefined;
}

function collectPathCandidates(toolName: string, input: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  collectNestedStringCandidates(toolName, input, candidates);
  return candidates;
}

function collectNestedStringCandidates(
  toolName: string,
  value: unknown,
  candidates: string[],
  key?: string,
): void {
  if (typeof value === 'string') {
    const isPatternKey = key != null && WORKSPACE_PATTERN_KEYS.has(key) && toolName === 'Glob';
    if (key && (WORKSPACE_PATH_KEYS.has(key) || isPatternKey)) {
      candidates.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNestedStringCandidates(toolName, entry, candidates, key);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    collectNestedStringCandidates(toolName, childValue, candidates, childKey);
  }
}

function collectCommandCandidates(input: Record<string, unknown>): string[] {
  const commands: string[] = [];
  collectNestedCommandCandidates(input, commands);
  return commands;
}

function collectNestedCommandCandidates(value: unknown, commands: string[], key?: string): void {
  if (typeof value === 'string') {
    if (key && WORKSPACE_COMMAND_KEYS.has(key)) {
      commands.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNestedCommandCandidates(entry, commands, key);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    collectNestedCommandCandidates(childValue, commands, childKey);
  }
}

function resolveToolPathCandidate(candidate: string, workDir: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }

  const pathPrefix = extractStablePathPrefix(trimmed);
  if (!pathPrefix) {
    return undefined;
  }

  if (pathPrefix.startsWith('~/')) {
    return normalize(resolve(homedir(), pathPrefix.slice(2)));
  }
  if (isAbsolute(pathPrefix)) {
    return normalize(pathPrefix);
  }

  return normalize(resolve(workDir, pathPrefix));
}

function extractStablePathPrefix(candidate: string): string | undefined {
  const normalizedCandidate = candidate.trim();
  if (!normalizedCandidate) {
    return undefined;
  }

  const globMetaIndex = normalizedCandidate.search(/[*?[\]{}()]/);
  const stablePrefix =
    globMetaIndex === -1 ? normalizedCandidate : normalizedCandidate.slice(0, globMetaIndex);
  const trimmedPrefix = stablePrefix.trim();
  if (!trimmedPrefix) {
    return undefined;
  }

  return trimmedPrefix;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  return buildAbsolutePathAliases(candidatePath).some((candidateAlias) =>
    buildAbsolutePathAliases(rootPath).some(
      (rootAlias) =>
        candidateAlias === rootAlias || candidateAlias.startsWith(`${rootAlias}${sep}`),
    ),
  );
}

function buildAbsolutePathAliases(targetPath: string): string[] {
  const normalizedTarget = normalize(targetPath);
  const aliases = new Set<string>([normalizedTarget]);

  if (normalizedTarget === '/tmp' || normalizedTarget.startsWith('/tmp/')) {
    aliases.add(`/private${normalizedTarget}`);
  }
  if (normalizedTarget === '/private/tmp' || normalizedTarget.startsWith('/private/tmp/')) {
    aliases.add(normalizedTarget.replace('/private/tmp', '/tmp'));
  }

  return [...aliases];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapHelixEffortToSdkEffort(
  effort: ModelSpec['effort'],
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
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
      return 'high';
  }
}
