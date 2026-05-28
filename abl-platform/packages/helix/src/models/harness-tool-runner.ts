import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

import { RepoIntelligenceService } from '../intelligence/repo-intelligence-service.js';
import { writeFileAtomic } from '../io/atomic-file.js';
import {
  buildWorkspacePathReplacements,
  rewriteTextToExecutionWorkspace,
  type WorkspacePathReplacement,
} from './workspace-grounding.js';
import type { StreamEvent, WorkspaceExecutionContext } from '../types.js';

const MAX_TOOL_OUTPUT_CHARS = 16_000;
const DEFAULT_READ_WINDOW_LINES = 200;
const DEFAULT_BASH_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_STUDIO_EVIDENCE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_JIRA_UPDATE_TIMEOUT_MS = 2 * 60_000;
const DIRECTORY_SKIP_SET = new Set([
  '.git',
  '.helix',
  '.turbo',
  '.apdas',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);
const BLOCKED_BASH_PATTERNS = [
  /\bgit\s+checkout\b/i,
  /\bgit\s+switch\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
] as const;

interface HarnessToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface HarnessToolResult {
  content: string;
  isError?: boolean;
}

export class HarnessToolRunner {
  private readonly repoIntelligence: RepoIntelligenceService;
  private workspaceContext?: WorkspaceExecutionContext;

  constructor(workDir: string, workspaceContext?: WorkspaceExecutionContext) {
    this.workDir = resolve(workDir);
    this.workspaceContext = workspaceContext;
    this.repoIntelligence = new RepoIntelligenceService({ workDir: this.workDir });
  }

  private readonly workDir: string;

  setWorkspaceContext(workspaceContext?: WorkspaceExecutionContext): void {
    this.workspaceContext = workspaceContext;
  }

  buildAnthropicTools(allowedTools: string[] | undefined): HarnessToolDefinition[] {
    const toolSet = new Set(allowedTools ?? []);
    return TOOL_DEFINITIONS.filter((tool) => toolSet.has(tool.name));
  }

  async executeTool(
    toolName: string,
    input: Record<string, unknown> | undefined,
    onStream?: (event: StreamEvent) => void,
  ): Promise<HarnessToolResult> {
    const payload = input ?? {};

    try {
      switch (toolName) {
        case 'Read':
          return this.readTool(payload);
        case 'Grep':
          return this.grepTool(payload);
        case 'Glob':
          return this.globTool(payload);
        case 'Bash':
          return this.bashTool(payload, onStream);
        case 'Write':
          return this.writeTool(payload);
        case 'Edit':
          return this.editTool(payload);
        case 'helix_find_symbol':
          return this.nativeJsonResult(
            await this.repoIntelligence.findSymbol(getString(payload, ['symbol']) ?? '', {
              scope: getStringArray(payload, ['scope']),
              limit: getNumber(payload, ['limit']),
            }),
          );
        case 'helix_find_references':
          return this.nativeJsonResult(
            await this.repoIntelligence.findReferences(
              getString(payload, ['filePath', 'file_path', 'path']) ?? '',
              getString(payload, ['symbol']) ?? '',
              {
                scope: getStringArray(payload, ['scope']),
                limit: getNumber(payload, ['limit']),
                includeDefinition: getBoolean(payload, ['includeDefinition', 'include_definition']),
              },
            ),
          );
        case 'helix_get_route_info':
          return this.nativeJsonResult(
            await this.repoIntelligence.getRouteInfo({
              filePath: getString(payload, ['filePath', 'file_path', 'path']),
              scope: getStringArray(payload, ['scope']),
              method: getString(payload, ['method']),
              pathContains: getString(payload, ['pathContains', 'path_contains']),
              limit: getNumber(payload, ['limit']),
            }),
          );
        case 'helix_get_schema_info':
          return this.nativeJsonResult(
            await this.repoIntelligence.getSchemaInfo({
              filePath: getString(payload, ['filePath', 'file_path', 'path']),
              symbol: getString(payload, ['symbol']),
              scope: getStringArray(payload, ['scope']),
              limit: getNumber(payload, ['limit']),
            }),
          );
        case 'helix_get_impacted_tests':
          return this.nativeJsonResult(
            await this.repoIntelligence.getImpactedTests({
              paths: getStringArray(payload, ['paths', 'files']) ?? [],
              scope: getStringArray(payload, ['scope']),
              limit: getNumber(payload, ['limit']),
            }),
          );
        case 'studio_video_evidence':
          return this.studioVideoEvidenceTool(payload, onStream);
        case 'jira_update':
          return this.jiraUpdateTool(payload, onStream);
        default:
          return {
            content: `Unknown tool: ${toolName}`,
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: truncateToolOutput(error instanceof Error ? error.message : String(error)),
        isError: true,
      };
    }
  }

  private async readTool(input: Record<string, unknown>): Promise<HarnessToolResult> {
    const targetPath = getString(input, ['path', 'filePath', 'file_path']);
    if (!targetPath) {
      return { content: 'Read requires a path.', isError: true };
    }

    const absolutePath = this.resolveWorkspacePath(targetPath);
    const raw = await readFile(absolutePath, 'utf-8');
    const lines = raw.split('\n');
    const startLine = Math.max(1, getNumber(input, ['startLine', 'start_line']) ?? 1);
    const requestedEndLine = getNumber(input, ['endLine', 'end_line']);
    const endLine = Math.min(
      lines.length,
      requestedEndLine ?? startLine + DEFAULT_READ_WINDOW_LINES - 1,
    );
    const excerpt = lines
      .slice(startLine - 1, endLine)
      .map((line, index) => `${startLine + index}: ${line}`)
      .join('\n');

    return {
      content: truncateToolOutput(
        [`Path: ${this.toRepoPath(absolutePath)}`, `Lines: ${startLine}-${endLine}`, excerpt]
          .filter(Boolean)
          .join('\n'),
      ),
    };
  }

  private async grepTool(input: Record<string, unknown>): Promise<HarnessToolResult> {
    const pattern = getString(input, ['pattern', 'query']);
    if (!pattern) {
      return { content: 'Grep requires a pattern.', isError: true };
    }

    const scopedPath = getString(input, ['path', 'filePath', 'file_path']);
    const baseDir = scopedPath ? this.resolveWorkspacePath(scopedPath) : this.workDir;
    const caseSensitive = getBoolean(input, ['caseSensitive', 'case_sensitive']) ?? true;
    const args = [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      ...(caseSensitive ? [] : ['-i']),
      pattern,
      baseDir,
    ];

    const result = await runSubprocess('rg', args, { cwd: this.workDir, timeoutMs: 30_000 }).catch(
      async (error) => {
        if (String(error).includes('ENOENT')) {
          const grepArgs = ['-R', '-n', ...(caseSensitive ? [] : ['-i']), pattern, baseDir];
          return runSubprocess('grep', grepArgs, { cwd: this.workDir, timeoutMs: 30_000 });
        }
        throw error;
      },
    );

    if (result.exitCode > 1) {
      return {
        content: truncateToolOutput(result.stderr || result.stdout || 'grep command failed'),
        isError: true,
      };
    }

    if (!result.stdout.trim()) {
      return { content: `No matches for ${JSON.stringify(pattern)}.` };
    }

    return {
      content: truncateToolOutput(result.stdout),
    };
  }

  private async globTool(input: Record<string, unknown>): Promise<HarnessToolResult> {
    const pattern = getString(input, ['pattern']);
    if (!pattern) {
      return { content: 'Glob requires a pattern.', isError: true };
    }

    const scopedPath = getString(input, ['path', 'basePath', 'base_path']);
    const baseDir = scopedPath ? this.resolveWorkspacePath(scopedPath) : this.workDir;
    const files = await this.walkFiles(baseDir);
    const matches = files
      .map((filePath) => this.toRepoPath(filePath))
      .filter((repoPath) => {
        const baseRelative = this.normalizeForGlob(
          relative(baseDir, resolve(this.workDir, repoPath)),
        );
        return (
          matchesGlobPattern(this.normalizeForGlob(repoPath), pattern) ||
          matchesGlobPattern(baseRelative, pattern) ||
          (!pattern.includes('/') &&
            matchesGlobPattern(repoPath.split('/').at(-1) ?? repoPath, pattern))
        );
      })
      .sort();

    if (matches.length === 0) {
      return { content: `No files matched ${JSON.stringify(pattern)}.` };
    }

    return {
      content: truncateToolOutput(matches.join('\n')),
    };
  }

  private async bashTool(
    input: Record<string, unknown>,
    onStream?: (event: StreamEvent) => void,
  ): Promise<HarnessToolResult> {
    const command = getString(input, ['command']);
    if (!command) {
      return { content: 'Bash requires a command.', isError: true };
    }

    const rewrittenCommand = rewriteTextToExecutionWorkspace(
      command,
      this.workDir,
      this.workspaceContext,
    );
    if (BLOCKED_BASH_PATTERNS.some((pattern) => pattern.test(rewrittenCommand))) {
      return {
        content:
          'Blocked destructive Bash command. Use HELIX workspace tools without switching branches or hard-resetting the repo.',
        isError: true,
      };
    }

    onStream?.({
      type: 'tool-use',
      timestamp: new Date().toISOString(),
      message: `Bash: ${rewrittenCommand}`,
      details: { tool: 'Bash', input: { command: rewrittenCommand } },
    });

    const result = await runSubprocess(process.env.SHELL || 'bash', ['-lc', rewrittenCommand], {
      cwd: this.workDir,
      timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

    onStream?.({
      type: result.exitCode === 0 ? 'progress' : 'error',
      timestamp: new Date().toISOString(),
      message: `Command exit ${result.exitCode}: ${truncateToolOutput(output || rewrittenCommand)}`,
    });

    return {
      content: truncateToolOutput(output || `(command exited ${result.exitCode} with no output)`),
      ...(result.exitCode === 0 ? {} : { isError: true }),
    };
  }

  private async writeTool(input: Record<string, unknown>): Promise<HarnessToolResult> {
    const targetPath = getString(input, ['path', 'filePath', 'file_path']);
    const content = getString(input, ['content']);
    if (!targetPath || content == null) {
      return { content: 'Write requires both path and content.', isError: true };
    }

    const absolutePath = this.resolveWorkspacePath(targetPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFileAtomic(absolutePath, content);
    return {
      content: `Wrote ${this.toRepoPath(absolutePath)} (${content.length} chars).`,
    };
  }

  private async editTool(input: Record<string, unknown>): Promise<HarnessToolResult> {
    const targetPath = getString(input, ['path', 'filePath', 'file_path']);
    const oldText = getString(input, ['oldText', 'old_text']);
    const newText = getString(input, ['newText', 'new_text']) ?? '';
    const replaceAll = getBoolean(input, ['replaceAll', 'replace_all']) ?? false;
    if (!targetPath || oldText == null) {
      return { content: 'Edit requires path and oldText.', isError: true };
    }

    const absolutePath = this.resolveWorkspacePath(targetPath);
    const original = await readFile(absolutePath, 'utf-8');
    if (!original.includes(oldText)) {
      return {
        content: `Could not find the requested text in ${this.toRepoPath(absolutePath)}.`,
        isError: true,
      };
    }

    const updated = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);
    await writeFileAtomic(absolutePath, updated);
    return {
      content: `Updated ${this.toRepoPath(absolutePath)}${replaceAll ? ' (all matches)' : ''}.`,
    };
  }

  private nativeJsonResult(value: unknown): HarnessToolResult {
    return {
      content: truncateToolOutput(JSON.stringify(value, null, 2)),
    };
  }

  private async studioVideoEvidenceTool(
    input: Record<string, unknown>,
    onStream?: (event: StreamEvent) => void,
  ): Promise<HarnessToolResult> {
    const args = ['studio:video:evidence', '--'];
    const issue = getString(input, ['issue', 'ticket']);
    const scenario = getString(input, ['scenario']);
    const surface = getString(input, ['surface']);
    const userMessage = getString(input, ['userMessage', 'user_message']);
    const assistantReply = getString(input, ['assistantReply', 'assistant_reply']);
    const finalPauseMs = getNumber(input, ['finalPauseMs', 'final_pause_ms']);
    const extraArgs = getStringArray(input, ['extraArgs', 'extra_args']) ?? [];

    if (scenario) {
      args.push('--scenario', scenario);
    }
    if (surface) {
      args.push('--surface', surface);
    }
    if (issue) {
      args.push('--issue', issue);
    }
    if (userMessage) {
      args.push('--user-message', userMessage);
    }
    if (assistantReply) {
      args.push('--assistant-reply', assistantReply);
    }
    if (finalPauseMs !== undefined) {
      args.push('--final-pause-ms', String(finalPauseMs));
    }
    args.push(...extraArgs);

    onStream?.({
      type: 'tool-use',
      timestamp: new Date().toISOString(),
      message: `Studio evidence: pnpm ${args.join(' ')}`,
      details: { tool: 'studio_video_evidence', input },
    });

    const result = await runSubprocess('pnpm', args, {
      cwd: this.workDir,
      timeoutMs:
        getNumber(input, ['timeoutMs', 'timeout_ms']) ?? DEFAULT_STUDIO_EVIDENCE_TIMEOUT_MS,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

    return {
      content: truncateToolOutput(output || `(studio evidence exited ${result.exitCode})`),
      ...(result.exitCode === 0 ? {} : { isError: true }),
    };
  }

  private async jiraUpdateTool(
    input: Record<string, unknown>,
    onStream?: (event: StreamEvent) => void,
  ): Promise<HarnessToolResult> {
    const ticket = getString(input, ['ticket', 'issue']);
    if (!ticket) {
      return { content: 'jira_update requires a ticket.', isError: true };
    }

    const args = ['jira:update', '--', ticket];
    for (const section of getSectionArray(input, ['commentSections', 'comment_sections'])) {
      args.push('--comment-section', `${section.heading}::${section.content}`);
    }
    for (const [flag, keys] of [
      ['--qa-shipped', ['qaShipped', 'qa_shipped']],
      ['--qa-verification', ['qaVerification', 'qa_verification']],
      ['--qa-follow-up', ['qaFollowUp', 'qa_follow_up']],
    ] as const) {
      const value = getString(input, keys);
      if (value) {
        args.push(flag, value);
      }
    }

    const transitionToStatus =
      getString(input, ['transitionToStatus', 'transition_to_status']) ??
      (getBoolean(input, ['developmentCompleted', 'development_completed'])
        ? 'Development Completed'
        : undefined);
    if (transitionToStatus) {
      args.push('--transition-to-status', transitionToStatus);
    }

    const assignee =
      getString(input, ['assignee']) ??
      (getBoolean(input, ['assignToPrakash', 'assign_to_prakash'])
        ? 'Prakash Rochkari'
        : undefined);
    if (assignee) {
      args.push('--assignee', assignee);
    }

    const attachments = getStringArray(input, ['attachments', 'evidencePaths', 'evidence_paths']);
    for (const attachment of attachments ?? []) {
      args.push('--attachment', attachment);
    }

    if (getBoolean(input, ['dryRun', 'dry_run'])) {
      args.push('--dry-run');
    }

    onStream?.({
      type: 'tool-use',
      timestamp: new Date().toISOString(),
      message: `Jira update: pnpm ${args.join(' ')}`,
      details: { tool: 'jira_update', input: { ...input, attachments } },
    });

    const result = await runSubprocess('pnpm', args, {
      cwd: this.workDir,
      timeoutMs: getNumber(input, ['timeoutMs', 'timeout_ms']) ?? DEFAULT_JIRA_UPDATE_TIMEOUT_MS,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

    return {
      content: truncateToolOutput(output || `(jira update exited ${result.exitCode})`),
      ...(result.exitCode === 0 ? {} : { isError: true }),
    };
  }

  private resolveWorkspacePath(rawPath: string): string {
    const rewritten = this.rewritePath(rawPath);
    const absolutePath = resolve(
      rewritten.startsWith(sep) ? rewritten : resolve(this.workDir, rewritten),
    );
    const relativePath = relative(this.workDir, absolutePath);
    if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')) {
      return absolutePath;
    }
    throw new Error(`Path ${rawPath} resolves outside the execution workspace.`);
  }

  private rewritePath(value: string): string {
    let rewritten = value;
    const replacements = buildWorkspacePathReplacements(this.workDir, this.workspaceContext);
    for (const replacement of replacements) {
      rewritten = rewriteWorkspacePathPrefix(rewritten, replacement);
    }
    return rewritten;
  }

  private toRepoPath(absolutePath: string): string {
    return this.normalizeForGlob(relative(this.workDir, absolutePath));
  }

  private normalizeForGlob(value: string): string {
    return value.split(sep).join('/');
  }

  private async walkFiles(rootDir: string): Promise<string[]> {
    const discovered: string[] = [];
    const pending = [rootDir];

    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        continue;
      }

      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (DIRECTORY_SKIP_SET.has(entry.name)) {
          continue;
        }
        const absolutePath = resolve(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(absolutePath);
        } else if (entry.isFile()) {
          discovered.push(absolutePath);
        }
      }
    }

    return discovered;
  }
}

const TOOL_DEFINITIONS: HarnessToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read a file from the current execution workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'Grep',
    description: 'Search workspace files for a regex pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        caseSensitive: { type: 'boolean' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'Glob',
    description: 'List workspace files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'Bash',
    description: 'Run a non-destructive shell command in the execution workspace.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'Write',
    description: 'Write a file inside the execution workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'Edit',
    description: 'Replace text inside a file in the execution workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },
  {
    name: 'helix_find_symbol',
    description: 'Find exported TypeScript symbols in a scoped part of the repo.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'helix_find_references',
    description: 'Find references to a TypeScript symbol in the repo.',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        symbol: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
        includeDefinition: { type: 'boolean' },
      },
      required: ['filePath', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'helix_get_route_info',
    description: 'Inspect Express route registrations and inherited middleware.',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' } },
        method: { type: 'string' },
        pathContains: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'helix_get_schema_info',
    description: 'Inspect exported Zod schemas and Mongoose schema definitions.',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        symbol: { type: 'string' },
        scope: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'helix_get_impacted_tests',
    description: 'Infer likely impacted tests for changed source files.',
    input_schema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        scope: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'studio_video_evidence',
    description:
      'Run the repo Studio UI video evidence harness and emit manifest, screenshot, and video artifact paths.',
    input_schema: {
      type: 'object',
      properties: {
        issue: { type: 'string' },
        scenario: { type: 'string' },
        surface: { type: 'string' },
        userMessage: { type: 'string' },
        assistantReply: { type: 'string' },
        finalPauseMs: { type: 'integer' },
        extraArgs: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'jira_update',
    description:
      'Update a Jira ticket with QA note sections, evidence attachments, transition, and assignment via the repo Jira helper.',
    input_schema: {
      type: 'object',
      properties: {
        ticket: { type: 'string' },
        commentSections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['heading', 'content'],
            additionalProperties: false,
          },
        },
        qaShipped: { type: 'string' },
        qaVerification: { type: 'string' },
        qaFollowUp: { type: 'string' },
        transitionToStatus: { type: 'string' },
        developmentCompleted: { type: 'boolean' },
        assignee: { type: 'string' },
        assignToPrakash: { type: 'boolean' },
        attachments: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
      required: ['ticket'],
      additionalProperties: false,
    },
  },
];

function getString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function getNumber(input: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function getBoolean(input: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

function getStringArray(
  input: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined {
  for (const key of keys) {
    const value = input[key];
    if (Array.isArray(value)) {
      return value.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      );
    }
  }
  return undefined;
}

function getSectionArray(
  input: Record<string, unknown>,
  keys: readonly string[],
): Array<{ heading: string; content: string }> {
  for (const key of keys) {
    const value = input[key];
    if (!Array.isArray(value)) {
      continue;
    }
    return value.flatMap((entry) => {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { heading?: unknown }).heading === 'string' &&
        typeof (entry as { content?: unknown }).content === 'string'
      ) {
        return [
          {
            heading: (entry as { heading: string }).heading,
            content: (entry as { content: string }).content,
          },
        ];
      }
      return [];
    });
  }
  return [];
}

function truncateToolOutput(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...[HELIX truncated tool output]`;
}

function rewriteWorkspacePathPrefix(value: string, replacement: WorkspacePathReplacement): string {
  if (value === replacement.from) {
    return replacement.to;
  }

  if (value.startsWith(`${replacement.from}${sep}`) || value.startsWith(`${replacement.from}/`)) {
    return `${replacement.to}${value.slice(replacement.from.length)}`;
  }

  return value;
}

function matchesGlobPattern(value: string, pattern: string): boolean {
  const regex = globToRegExp(pattern);
  return regex.test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    const next = pattern[index + 1];

    if (char === '*') {
      if (next === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegExp(char);
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

async function runSubprocess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}
