import type { ExecutorEfficiencyBudget } from '../types.js';

const READ_REPEAT_LIMIT = 2;
const SEARCH_REPEAT_LIMIT = 1;
const SHELL_REPEAT_WARN_LIMIT = 2;
const SHELL_REPEAT_ABORT_LIMIT = 3;
const TOTAL_SHELL_EXPLORATION_WARN_LIMIT = 6;
const TOTAL_SHELL_EXPLORATION_ABORT_LIMIT = 10;
const BROAD_BUILD_REPEAT_WARN_LIMIT = 2;
const BROAD_BUILD_REPEAT_ABORT_LIMIT = 4;
const SHELL_WRAPPER_RE = /^\/bin\/(?:ba)?sh\s+-[a-z]*c\s+/;
const SHELL_QUOTE_RE = /^(['"])(.*)\1$/s;
const SED_RANGE_RE = /\bsed\s+-n\s+(['"])[^'"]*\1\s+/g;
const NL_SED_RANGE_RE = /\bnl\s+-ba\s+(\S+)\s*\|\s*sed\s+-n\s+(['"])[^'"]*\2/g;
const EXPLORATORY_SHELL_COMMAND_RE =
  /^(?:pwd|rg|grep|find|fd|ls|cat|sed|head|tail|nl|read|git\s+(?:status|diff|show|log))\b/i;
const DIRECT_FILE_READ_SHELL_COMMAND_RE =
  /^(?:(?:cat|head|tail)\b|sed\s+-n\b|read\s+\S+)(?!.*(?:\||&&|;))/i;
const LINE_NUMBER_FILE_READ_SHELL_COMMAND_RE =
  /^nl\s+-ba\s+\S+(?:\s*\|\s*sed\s+-n\b(?!.*(?:&&|;)).*)?$/i;
const SCOPED_SEARCH_SHELL_COMMAND_RE =
  /^(?:rg|grep)\b(?!.*\b--files\b).*\b(?:apps|packages)\/[^\s'"]+/i;
const SCOPED_FIND_SHELL_COMMAND_RE = /^find\s+(?:apps|packages)\/[^\s'"]+(?:\s|$)/i;
const BROAD_FIND_MAX_DEPTH_RE = /\b-maxdepth\s+([0-9]+)\b/i;
const BROAD_BUILD_COMMAND_RE =
  /^(?:(?:pnpm|npm|yarn|bun)\s+(?:--\S+\s+)*(?:run\s+)?build\b|(?:pnpm|npm|yarn|bun)\s+(?:--\S+\s+)*--dir\s+\S+\s+build\b|(?:pnpm|npm|yarn|bun)\s+(?:--\S+\s+)*--filter(?:=|\s+)\S+\s+build\b|(?:next|nuxt|vite)\s+build\b|(?:turbo|turborepo)\s+(?:run\s+)?build\b)/i;
const SED_FILE_READ_RE = /^sed\s+-n\s+(['"]).*?\1\s+(\S+)$/i;
const CAT_HEAD_TAIL_FILE_READ_RE =
  /^(?:cat(?:\s+-n)?|head(?:\s+-n\s+\d+)?|tail(?:\s+-n\s+\d+)?)\s+(\S+)$/i;
const NL_FILE_READ_RE = /^nl\s+-ba\s+(\S+)(?:\s*\|\s*sed\s+-n\s+.*)?$/i;

type ToolDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

interface ShellCommandDecision {
  warnings: string[];
  abortMessage?: string;
}

export class ExecutorEfficiencyController {
  private readonly repeatedLookupCounts = new Map<string, number>();
  private readonly hardTurnCapValue?: number;
  private readonly forbiddenShellPatterns: RegExp[];
  private exploratoryShellCommandCount = 0;
  private totalShellCommandCount = 0;
  private scopedShellInspectionCount = 0;
  private scopedToolInspectionCount = 0;
  private explorationBudgetAnnounced = false;
  private targetBudgetAnnounced = false;
  private hardCapAnnounced = false;

  constructor(private readonly budget?: ExecutorEfficiencyBudget) {
    if (budget) {
      this.hardTurnCapValue =
        budget.hardTurnCap ??
        Math.max(budget.targetTurns * 2, budget.targetTurns + 8, budget.explorationTurns + 6);
    }
    this.forbiddenShellPatterns = (budget?.forbiddenShellPatterns ?? [])
      .map((pattern) => {
        try {
          return new RegExp(pattern, 'i');
        } catch {
          return null;
        }
      })
      .filter((pattern): pattern is RegExp => pattern !== null);
  }

  get hardTurnCap(): number | undefined {
    return this.hardTurnCapValue;
  }

  get isEnabled(): boolean {
    return this.budget != null;
  }

  resolveMaxTurns(existingMaxTurns?: number): number | undefined {
    if (this.hardTurnCapValue == null) {
      return existingMaxTurns;
    }

    return existingMaxTurns == null
      ? this.hardTurnCapValue
      : Math.min(existingMaxTurns, this.hardTurnCapValue);
  }

  noteTurn(turnsUsed: number): string[] {
    if (!this.budget) {
      return [];
    }

    const messages: string[] = [];
    if (!this.explorationBudgetAnnounced && turnsUsed >= this.budget.explorationTurns) {
      this.explorationBudgetAnnounced = true;
      messages.push(
        `HELIX efficiency budget: exploration budget reached at turn ${turnsUsed}/${this.budget.targetTurns}. Stop broad discovery and start implementing with the evidence already gathered.`,
      );
    }

    if (!this.targetBudgetAnnounced && turnsUsed >= this.budget.targetTurns) {
      this.targetBudgetAnnounced = true;
      messages.push(
        `HELIX efficiency budget: target turn budget reached at turn ${turnsUsed}. Prefer edits, verification, or a blocker summary over more exploration.`,
      );
    }

    if (
      !this.hardCapAnnounced &&
      this.hardTurnCapValue != null &&
      turnsUsed >= this.hardTurnCapValue
    ) {
      this.hardCapAnnounced = true;
      messages.push(
        `HELIX efficiency budget: hard cap reached at turn ${turnsUsed}. The executor should stop this trajectory and retry with the evidence already collected.`,
      );
    }

    return messages;
  }

  getHardCapAbortMessage(turnsUsed: number, engineName: string): string | undefined {
    if (!this.budget || this.hardTurnCapValue == null || turnsUsed < this.hardTurnCapValue) {
      return undefined;
    }

    return `${engineName} exceeded the HELIX efficiency hard cap (${turnsUsed}/${this.hardTurnCapValue} turns). Retry with the gathered evidence instead of continuing the same exploration loop.`;
  }

  evaluateToolUse(
    toolName: string,
    input: Record<string, unknown> | undefined,
    turnsUsed: number,
  ): ToolDecision {
    if (!this.budget) {
      return { behavior: 'allow' };
    }

    if (this.budget.disableToolUse) {
      return {
        behavior: 'deny',
        message:
          'HELIX efficiency budget disabled tool use for this recovery retry. Synthesize the result from the seam evidence already gathered instead of reopening files or rerunning lookups.',
      };
    }

    if (this.hardTurnCapValue != null && turnsUsed >= this.hardTurnCapValue) {
      const message = this.getHardCapAbortMessage(turnsUsed, 'Claude');
      return {
        behavior: 'deny',
        message:
          message ??
          `Claude exceeded the HELIX efficiency hard cap at turn ${turnsUsed}. Retry with the evidence already gathered.`,
      };
    }

    const fingerprint = buildToolFingerprint(toolName, input);
    if (!fingerprint) {
      return { behavior: 'allow' };
    }

    const key = `tool:${toolName}:${fingerprint}`;
    const nextCount = (this.repeatedLookupCounts.get(key) ?? 0) + 1;
    this.repeatedLookupCounts.set(key, nextCount);

    const scopedToolInspectionCountLimit = this.budget.scopedToolInspectionCountLimit;
    if (
      turnsUsed >= this.budget.explorationTurns &&
      isScopedInspectionToolUse(toolName, input) &&
      scopedToolInspectionCountLimit != null
    ) {
      this.scopedToolInspectionCount += 1;
      if (
        this.budget.abortScopedToolInspectionAfterLimit &&
        this.scopedToolInspectionCount > scopedToolInspectionCountLimit
      ) {
        return {
          behavior: 'deny',
          message: `HELIX blocked additional scoped ${toolName} inspection after the replay seam window (${scopedToolInspectionCountLimit} tool lookup(s)) was consumed. Synthesize the stage result from the primary seam evidence instead of continuing helper-level validation.`,
        };
      }

      if (nextCount === 1 && this.scopedToolInspectionCount <= scopedToolInspectionCountLimit) {
        return { behavior: 'allow' };
      }
    }

    if (
      this.budget.abortExploratoryToolUseAfterTargetTurns &&
      turnsUsed >= this.budget.targetTurns &&
      isExploratoryToolName(toolName)
    ) {
      return {
        behavior: 'deny',
        message: `HELIX efficiency budget blocked exploratory ${toolName} lookup "${fingerprint}" after the target turn budget (${this.budget.targetTurns}) was reached. Synthesize from the gathered seam evidence or ask for recovery guidance instead of continuing discovery.`,
      };
    }

    if (turnsUsed < this.budget.explorationTurns) {
      return { behavior: 'allow' };
    }

    const repeatLimit = repeatLimitForTool(toolName);
    if (repeatLimit == null || nextCount <= repeatLimit) {
      return { behavior: 'allow' };
    }

    return {
      behavior: 'deny',
      message: `HELIX efficiency budget blocked repeated ${toolName} lookup "${fingerprint}" after ${nextCount - 1} prior attempt(s). Exploration budget: ${this.budget.explorationTurns}; target turns: ${this.budget.targetTurns}. Implement with the evidence you already have or summarize the exact missing gap instead of re-running the same lookup.`,
    };
  }

  evaluateShellCommand(
    command: string,
    turnsUsed: number,
    isBuildOrTestCommand: boolean,
    elapsedMs?: number,
  ): ShellCommandDecision {
    if (!this.budget) {
      return { warnings: [] };
    }

    const fingerprint = normalizeShellCommand(command);
    if (!fingerprint) {
      return { warnings: [] };
    }

    if (isBuildOrTestCommand) {
      return this.evaluateBuildOrTestCommand(fingerprint, turnsUsed);
    }

    this.totalShellCommandCount += 1;

    if (this.hardTurnCapValue != null && turnsUsed >= this.hardTurnCapValue) {
      return {
        warnings: [],
        abortMessage:
          this.getHardCapAbortMessage(turnsUsed, 'Codex') ??
          `Codex exceeded the HELIX efficiency hard cap at turn ${turnsUsed}. Retry with the evidence already gathered.`,
      };
    }

    if (
      turnsUsed >= this.budget.explorationTurns &&
      this.forbiddenShellPatterns.some((pattern) => pattern.test(fingerprint))
    ) {
      return {
        warnings: [],
        abortMessage: `Codex issued the replay-disallowed exploratory shell command "${previewCommand(
          fingerprint,
        )}" after the HELIX exploration budget. Stop rediscovering the workspace and continue from the historical seam evidence already gathered.`,
      };
    }

    if (!EXPLORATORY_SHELL_COMMAND_RE.test(fingerprint)) {
      const zeroTurnAbortMessage = this.getZeroTurnShellAbortMessage(turnsUsed, elapsedMs);
      if (zeroTurnAbortMessage) {
        return { warnings: [], abortMessage: zeroTurnAbortMessage };
      }
      return { warnings: [] };
    }

    const key = `command:${fingerprint}`;
    const nextCount = (this.repeatedLookupCounts.get(key) ?? 0) + 1;
    this.repeatedLookupCounts.set(key, nextCount);

    const isScopedInspection =
      isDirectShellFileReadCommand(fingerprint) ||
      (this.budget.allowScopedShellInspection && isScopedShellInspectionCommand(fingerprint));

    if (
      this.budget.abortExploratoryToolUseAfterTargetTurns &&
      turnsUsed >= this.budget.targetTurns &&
      !isScopedInspection
    ) {
      return {
        warnings: [],
        abortMessage: `Codex issued the exploratory shell command "${previewCommand(fingerprint)}" after reaching the HELIX target turn budget (${this.budget.targetTurns}). Stop discovery and continue from the seam evidence already gathered.`,
      };
    }

    if (isScopedInspection) {
      this.scopedShellInspectionCount += 1;
      const scopedShellInspectionCountLimit = this.budget.scopedShellInspectionCountLimit;
      if (
        turnsUsed >= this.budget.explorationTurns &&
        this.budget.abortScopedShellInspectionAfterLimit &&
        scopedShellInspectionCountLimit != null &&
        this.scopedShellInspectionCount > scopedShellInspectionCountLimit
      ) {
        return {
          warnings: [],
          abortMessage: `Codex continued helper-level scoped seam inspection after consuming the HELIX seam-inspection window (${scopedShellInspectionCountLimit} command(s)). Stop this trajectory and synthesize the stage result from the primary seam evidence already gathered.`,
        };
      }

      if (
        nextCount === 1 &&
        (scopedShellInspectionCountLimit == null ||
          this.scopedShellInspectionCount <= scopedShellInspectionCountLimit)
      ) {
        const zeroTurnAbortMessage = this.getZeroTurnShellAbortMessage(turnsUsed, elapsedMs);
        if (zeroTurnAbortMessage) {
          return { warnings: [], abortMessage: zeroTurnAbortMessage };
        }
        return { warnings: [] };
      }
    }

    this.exploratoryShellCommandCount += 1;

    const warnings: string[] = [];
    if (this.exploratoryShellCommandCount === this.getTotalShellExplorationWarnLimit()) {
      warnings.push(
        `HELIX efficiency budget: too many shell exploration commands (${this.exploratoryShellCommandCount}) after the exploration budget. Prefer the native tools or summarize the seam instead of continuing shell-driven rediscovery.`,
      );
    }

    if (turnsUsed >= this.budget.explorationTurns && nextCount === SHELL_REPEAT_WARN_LIMIT) {
      warnings.push(
        `HELIX efficiency budget: repeated shell exploration command "${previewCommand(fingerprint)}" detected after the exploration budget. Prefer implementing or summarizing the blocker instead of re-running the same lookup.`,
      );
    }

    if (this.exploratoryShellCommandCount >= this.getTotalShellExplorationAbortLimit()) {
      return {
        warnings,
        abortMessage: `Codex issued ${this.exploratoryShellCommandCount} exploratory shell commands, exceeding HELIX's shell exploration budget. Stop this shell-heavy trajectory and continue from the evidence already gathered.`,
      };
    }

    if (turnsUsed >= this.budget.targetTurns && nextCount >= SHELL_REPEAT_ABORT_LIMIT) {
      return {
        warnings,
        abortMessage: `Codex repeated the shell exploration command "${previewCommand(fingerprint)}" ${nextCount} times after reaching the HELIX target turn budget (${this.budget.targetTurns}). Stopping this trajectory so HELIX can retry or ask for recovery guidance.`,
      };
    }

    const zeroTurnAbortMessage = this.getZeroTurnShellAbortMessage(turnsUsed, elapsedMs);
    if (zeroTurnAbortMessage) {
      return {
        warnings,
        abortMessage: zeroTurnAbortMessage,
      };
    }

    return { warnings };
  }

  private getZeroTurnShellAbortMessage(turnsUsed: number, elapsedMs?: number): string | undefined {
    if (!this.budget || turnsUsed > 0) {
      return undefined;
    }

    const zeroTurnShellAbortFloor = this.budget.zeroTurnShellAbortFloor;
    const zeroTurnElapsedAbortMs = this.budget.zeroTurnElapsedAbortMs;
    const exceededShellFloor =
      zeroTurnShellAbortFloor != null && this.totalShellCommandCount >= zeroTurnShellAbortFloor;
    const exceededElapsedFloor =
      zeroTurnElapsedAbortMs != null &&
      elapsedMs != null &&
      elapsedMs >= zeroTurnElapsedAbortMs &&
      this.totalShellCommandCount > 0;

    if (!exceededShellFloor && !exceededElapsedFloor) {
      return undefined;
    }

    if (exceededShellFloor) {
      return `Codex issued ${this.totalShellCommandCount} shell commands without producing a model turn, exceeding HELIX's zero-turn shell saturation floor (${zeroTurnShellAbortFloor}). Stop this trajectory and synthesize from the seam evidence already gathered.`;
    }

    return `Codex spent ${Math.ceil((elapsedMs ?? 0) / 1000)}s in shell-only startup without producing a model turn, exceeding HELIX's zero-turn elapsed rescue window (${Math.ceil((zeroTurnElapsedAbortMs ?? 0) / 1000)}s). Stop this trajectory and synthesize from the seam evidence already gathered.`;
  }

  private evaluateBuildOrTestCommand(fingerprint: string, turnsUsed: number): ShellCommandDecision {
    if (!isBroadBuildCommand(fingerprint)) {
      return { warnings: [] };
    }

    const key = `broad-build:${fingerprint}`;
    const nextCount = (this.repeatedLookupCounts.get(key) ?? 0) + 1;
    this.repeatedLookupCounts.set(key, nextCount);

    const warnings: string[] = [];
    if (turnsUsed >= this.budget!.explorationTurns && nextCount === BROAD_BUILD_REPEAT_WARN_LIMIT) {
      warnings.push(
        `HELIX efficiency budget: repeated broad proof command "${previewCommand(fingerprint)}" detected. Reuse the preloaded scoped verification command unless a failure proves the broader build is required.`,
      );
    }

    if (turnsUsed >= this.budget!.targetTurns && nextCount >= BROAD_BUILD_REPEAT_ABORT_LIMIT) {
      return {
        warnings,
        abortMessage: `Codex repeated the broad proof command "${previewCommand(fingerprint)}" ${nextCount} times after reaching the HELIX target turn budget (${this.budget!.targetTurns}). Stop rerunning the same full build and continue with the scoped proof evidence already gathered.`,
      };
    }

    return { warnings };
  }

  private getTotalShellExplorationWarnLimit(): number {
    if (!this.budget) {
      return TOTAL_SHELL_EXPLORATION_WARN_LIMIT;
    }

    if (this.budget.shellWarnFloor != null) {
      return this.budget.shellWarnFloor;
    }

    return Math.max(TOTAL_SHELL_EXPLORATION_WARN_LIMIT, this.budget.explorationTurns * 2);
  }

  private getTotalShellExplorationAbortLimit(): number {
    if (!this.budget) {
      return TOTAL_SHELL_EXPLORATION_ABORT_LIMIT;
    }

    if (this.budget.shellAbortFloor != null) {
      return this.budget.shellAbortFloor;
    }

    return Math.max(
      TOTAL_SHELL_EXPLORATION_ABORT_LIMIT,
      this.budget.targetTurns + this.budget.explorationTurns,
    );
  }
}

function isExploratoryToolName(toolName: string): boolean {
  return toolName === 'Glob' || toolName === 'Grep';
}

function buildToolFingerprint(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) {
    return undefined;
  }

  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return firstNonEmptyString(input['file_path'], input['path']);
    case 'MultiEdit':
      return normalizeStringArray(input['paths']) ?? firstNonEmptyString(input['file_path']);
    case 'Grep':
    case 'Glob': {
      const pattern = firstNonEmptyString(input['pattern']);
      const scope = firstNonEmptyString(input['path'], input['directory'], input['cwd']);
      if (pattern && scope) {
        return `${pattern} @ ${scope}`;
      }
      return pattern ?? scope ?? undefined;
    }
    case 'Bash':
      return normalizeShellCommand(firstNonEmptyString(input['command'], input['cmd']) ?? '');
    default:
      return undefined;
  }
}

function isScopedInspectionToolUse(
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (!input) {
    return false;
  }

  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return isScopedRepoPath(firstNonEmptyString(input['file_path'], input['path']));
    case 'Grep':
    case 'Glob':
      return isScopedRepoPath(firstNonEmptyString(input['path'], input['directory'], input['cwd']));
    default:
      return false;
  }
}

function repeatLimitForTool(toolName: string): number | undefined {
  switch (toolName) {
    case 'Read':
      return READ_REPEAT_LIMIT;
    case 'Grep':
    case 'Glob':
    case 'Bash':
      return SEARCH_REPEAT_LIMIT;
    default:
      return undefined;
  }
}

function normalizeStringArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  if (items.length === 0) {
    return undefined;
  }

  return items
    .map((entry) => entry.trim())
    .sort()
    .join(', ');
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isScopedRepoPath(value: string | undefined): boolean {
  return value != null && /(^|\/)(apps|packages)\//.test(value);
}

function normalizeShellCommand(command: string): string | undefined {
  let normalized = command.trim();
  if (!normalized) {
    return undefined;
  }

  normalized = normalized.replace(SHELL_WRAPPER_RE, '').trim();
  const quoteMatch = normalized.match(SHELL_QUOTE_RE);
  if (quoteMatch) {
    normalized = quoteMatch[2].trim();
  }

  const normalizedRead = normalizeReadShellCommand(normalized);
  if (normalizedRead) {
    return normalizedRead;
  }

  normalized = normalized.replace(NL_SED_RANGE_RE, 'nl -ba $1 ').replace(SED_RANGE_RE, 'sed ');

  return normalized.replace(/\s+/g, ' ').trim();
}

function normalizeReadShellCommand(command: string): string | undefined {
  const sedMatch = command.match(SED_FILE_READ_RE);
  if (sedMatch) {
    return `read ${sedMatch[2]}`;
  }

  const catHeadTailMatch = command.match(CAT_HEAD_TAIL_FILE_READ_RE);
  if (catHeadTailMatch) {
    return `read ${catHeadTailMatch[1]}`;
  }

  const lineNumberMatch = command.match(NL_FILE_READ_RE);
  if (lineNumberMatch) {
    return `read ${lineNumberMatch[1]}`;
  }

  return undefined;
}

function isBroadBuildCommand(command: string): boolean {
  return BROAD_BUILD_COMMAND_RE.test(command);
}

function isDirectShellFileReadCommand(command: string): boolean {
  return DIRECT_FILE_READ_SHELL_COMMAND_RE.test(command);
}

function isScopedShellInspectionCommand(command: string): boolean {
  if (LINE_NUMBER_FILE_READ_SHELL_COMMAND_RE.test(command)) {
    return true;
  }

  if (SCOPED_SEARCH_SHELL_COMMAND_RE.test(command)) {
    return true;
  }

  if (!SCOPED_FIND_SHELL_COMMAND_RE.test(command)) {
    return false;
  }

  const maxDepth = command.match(BROAD_FIND_MAX_DEPTH_RE)?.[1];
  if (!maxDepth) {
    return false;
  }

  return Number.parseInt(maxDepth, 10) <= 2;
}

function previewCommand(command: string, maxLength: number = 96): string {
  return command.length <= maxLength ? command : `${command.slice(0, maxLength)}...`;
}
