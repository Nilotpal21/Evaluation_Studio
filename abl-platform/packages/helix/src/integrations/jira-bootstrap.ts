/**
 * Pure helpers for bootstrapping a `WorkItem` from a Jira ticket key.
 *
 * The CLI calls `getIssue` (the only impure boundary, in `jira-client.ts`) and
 * passes the result through these pure functions to produce a `WorkItem`
 * partial and a `BootstrapMeta` record. Tested via in-memory inputs — no
 * network, no filesystem inside the pure functions; the workspace enumerator
 * is the one impure helper, isolated and DI-friendly via its `workDir` param.
 *
 * See LLD `docs/plans/2026-05-01-helix-work-item-bootstrap-impl-plan.md` §3
 * Phase 1, tasks 1.2 and 1.5.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type {
  BootstrapMeta,
  BootstrapFallbackReason,
  BootstrapScopeInferenceMethod,
  WorkItem,
} from '../types.js';
import type { JiraAssignedIssue } from './jira-client.js';

// ─── Constants ───────────────────────────────────────────────────

/** Maximum number of inferred scope entries kept in `bootstrapMeta.inferredScope` and `WorkItem.scope`. */
export const MAX_INFERRED_SCOPE = 5;

const JIRA_KEY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/;

const PNPM_WORKSPACE_YAML = 'pnpm-workspace.yaml';

// Default fallback roots when pnpm-workspace.yaml is absent or unparseable.
const DEFAULT_WORKSPACE_ROOTS = ['apps', 'packages'];

// Module-level cache for enumerateWorkspacePackages — single-entry, process-scoped, no TTL.
// Helix is a CLI tool; the process exits when work is done, so a single entry suffices.
let cachedWorkspacePackages: { workDir: string; packages: string[] } | undefined;

// ─── Regex / Type Guard ──────────────────────────────────────────

/**
 * Detects whether a string looks like a real Jira key (e.g. `ABLP-123`,
 * `AB1-9`). Allows digits after the first letter — matches Jira's actual key
 * shape. The canonical declaration; previously redeclared in
 * `pipeline/commit-manager.ts` which now imports this.
 */
export function isRealJiraKey(value: string | undefined): value is string {
  return value != null && JIRA_KEY_REGEX.test(value);
}

// ─── Workspace Enumeration ───────────────────────────────────────

/**
 * Read the TARGET repo's `pnpm-workspace.yaml` from `workDir` and resolve its
 * `packages:` glob patterns to a list of root-relative directory paths
 * (e.g. `apps/runtime`, `packages/database`). When the yaml is absent or
 * unparseable, falls back to enumerating immediate children of `apps/` and
 * `packages/` that contain a `package.json`.
 *
 * Note: `helix` itself is excluded from the abl-platform workspace, but Helix
 * audits other repos at runtime — this function reads the *target* repo's
 * yaml at `workDir`, not Helix's own.
 *
 * Cached at module level for one CLI invocation. Process-scoped, single entry.
 */
export async function enumerateWorkspacePackages(workDir: string): Promise<string[]> {
  const normalizedWorkDir = resolve(workDir);
  if (cachedWorkspacePackages?.workDir === normalizedWorkDir) {
    return cachedWorkspacePackages.packages;
  }

  const packages = await readWorkspacePackages(normalizedWorkDir);
  cachedWorkspacePackages = { workDir: normalizedWorkDir, packages };
  return packages;
}

/** Test-only cache reset. Not exported from the package barrel. */
export function __resetWorkspacePackagesCacheForTests(): void {
  cachedWorkspacePackages = undefined;
}

async function readWorkspacePackages(workDir: string): Promise<string[]> {
  const yamlPath = join(workDir, PNPM_WORKSPACE_YAML);
  let yamlText: string | undefined;
  try {
    yamlText = await readFile(yamlPath, 'utf-8');
  } catch {
    return await enumerateDefaultRoots(workDir);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return await enumerateDefaultRoots(workDir);
  }

  const patterns = extractPackagePatterns(parsed);
  if (patterns.length === 0) {
    return await enumerateDefaultRoots(workDir);
  }

  return await resolvePatterns(workDir, patterns);
}

function extractPackagePatterns(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const value = (parsed as { packages?: unknown }).packages;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

async function resolvePatterns(workDir: string, patterns: string[]): Promise<string[]> {
  const result = new Set<string>();

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith('!')) {
      // v1 ignores exclusions per LLD §7 OQ #2.
      continue;
    }

    const wildcardIndex = pattern.indexOf('*');
    if (wildcardIndex === -1) {
      // Literal directory like `scripts/conversation-testing` — accept if it has a package.json.
      if (await hasPackageJson(join(workDir, pattern))) {
        result.add(normalizeRelative(pattern));
      }
      continue;
    }

    // Pattern like `packages/*` or `packages/connectors/*`. Resolve the prefix
    // (everything before the first '*') and enumerate its immediate children.
    const prefix = pattern.slice(0, wildcardIndex).replace(/\/+$/, '');
    if (!prefix) continue;
    const baseDir = join(workDir, prefix);

    let entries: string[];
    try {
      const { readdir } = await import('node:fs/promises');
      entries = await readdir(baseDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = join(baseDir, entry);
      if (await hasPackageJson(fullPath)) {
        result.add(normalizeRelative(`${prefix}/${entry}`));
      }
    }
  }

  return Array.from(result).sort();
}

async function enumerateDefaultRoots(workDir: string): Promise<string[]> {
  const result = new Set<string>();
  const { readdir } = await import('node:fs/promises');

  for (const root of DEFAULT_WORKSPACE_ROOTS) {
    const baseDir = join(workDir, root);
    let entries: string[];
    try {
      entries = await readdir(baseDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (await hasPackageJson(join(baseDir, entry))) {
        result.add(normalizeRelative(`${root}/${entry}`));
      }
    }
  }

  return Array.from(result).sort();
}

async function hasPackageJson(dir: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const info = await stat(join(dir, 'package.json'));
    return info.isFile();
  } catch {
    return false;
  }
}

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

// ─── Scope Inference ─────────────────────────────────────────────

/**
 * Scan plain text for path-prefix mentions of known workspace packages.
 *
 * Match rule: a workspace package `apps/runtime` matches when the text
 * contains a token beginning with `apps/runtime` followed by either end-of-
 * token (whitespace/punctuation/newline) or a path separator (`/`). This
 * accepts `apps/runtime`, `apps/runtime/src/sessions`, but NOT
 * `apps/runtime-extras` (which is a different package) or
 * `../../apps/runtime` (path traversal — workspace roots only match at
 * non-path-segment boundaries).
 *
 * Returns the first MAX_INFERRED_SCOPE distinct matches in description
 * order. Matches at `../` traversal boundaries are rejected.
 */
export function inferScopeFromText(text: string, workspacePackages: string[]): string[] {
  if (!text || workspacePackages.length === 0) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  // Sort by length descending so a more-specific match (`packages/connectors/foo`)
  // wins over a shorter prefix (`packages/connectors`) at the same position.
  const sortedPackages = [...workspacePackages].sort((a, b) => b.length - a.length);

  // Tokenize on whitespace and common punctuation so paths embedded in prose
  // (`"... touches apps/runtime/src/sessions and packages/execution."`) are
  // split into individual tokens we can prefix-test.
  const tokens = text.split(/[\s,;:()\[\]{}"'`]+/).filter(Boolean);

  for (const rawToken of tokens) {
    if (result.length >= MAX_INFERRED_SCOPE) break;

    // Strip trailing punctuation that survived the tokenizer (e.g. ".")
    const token = rawToken.replace(/[.!?]+$/, '');
    if (!token) continue;

    // Reject path traversal — workspace packages must appear at the start of
    // a path segment that isn't preceded by `..`.
    if (token.includes('../') || token.startsWith('..')) continue;

    // Strip leading `./` so `"./apps/runtime"` matches `"apps/runtime"`.
    const normalized = token.startsWith('./') ? token.slice(2) : token;

    for (const pkg of sortedPackages) {
      if (normalized === pkg || normalized.startsWith(`${pkg}/`)) {
        if (!seen.has(pkg)) {
          seen.add(pkg);
          result.push(pkg);
        }
        break;
      }
    }
  }

  return result;
}

// ─── Acceptance Criteria Extraction ─────────────────────────────

/**
 * Extract acceptance criteria from a Jira issue description (plain text).
 *
 * Looks for common section headings such as "Acceptance Criteria",
 * "Acceptance", or "AC:" and extracts bullet / numbered list items that
 * follow. Handles both Markdown-style lists (`- item`, `* item`, `1. item`)
 * and plain-line AC blocks.
 *
 * Returns an empty array when no AC section is found or the description is
 * blank — callers should treat `[]` as "no structured AC available."
 *
 * This is a deterministic, pure function with no filesystem or network access.
 */
export function extractAcceptanceCriteria(descriptionText: string): string[] {
  if (!descriptionText || descriptionText.trim().length === 0) return [];

  const lines = descriptionText.split(/\r?\n/);
  const acHeadingRegex =
    /^(?:#{1,4}\s*)?(?:acceptance[\s_-]*criteria|acceptance|ac\s*:|given[\s_-]when[\s_-]then)/i;
  const nextSectionRegex = /^#{1,4}\s+\S/;
  const bulletRegex = /^[\s]*(?:[-*+]|\d+[.)]\s)\s*/;

  const result: string[] = [];
  let inAcSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (acHeadingRegex.test(trimmed)) {
      inAcSection = true;
      continue;
    }

    if (inAcSection) {
      // Stop when we hit a new top-level heading (but not if it's a sub-bullet)
      if (nextSectionRegex.test(trimmed) && !bulletRegex.test(trimmed)) {
        break;
      }

      if (bulletRegex.test(trimmed)) {
        const item = trimmed.replace(bulletRegex, '').trim();
        if (item.length > 0) {
          result.push(item);
        }
      } else if (trimmed.length > 0 && result.length > 0) {
        // Continuation of a previous AC item (indented / wrapped)
        result[result.length - 1] += ' ' + trimmed;
      }
    }
  }

  return result;
}

// ─── Bootstrap Mapping ───────────────────────────────────────────

export interface CliOverrides {
  title?: string;
  description?: string;
  scope?: string[];
}

export interface BootstrapResult {
  /** Fields to merge into the `WorkItem` literal — explicit CLI flags MUST win. */
  partialWorkItem: Pick<WorkItem, 'title' | 'description' | 'scope' | 'jiraKey'>;
  bootstrapMeta: BootstrapMeta;
}

/**
 * Combine a Jira-fetched issue (or `null` for a failed fetch) with CLI
 * overrides into a `WorkItem` partial and a `BootstrapMeta` telemetry record.
 *
 * Precedence (FR-4):
 *   1. CLI override (when a field is supplied via flag) wins.
 *   2. Otherwise, Jira value fills it.
 *   3. Otherwise, the Jira key string fills it (degraded fallback).
 *
 * Locked invariant: when `cliOverrides.scope` is supplied (non-empty),
 * `inferredScope === []` and `scopeInferenceMethod === 'explicit'`. The
 * inference branch is short-circuited.
 */
export function mapJiraIssueToWorkItem(
  issue: JiraAssignedIssue | null,
  jiraKey: string,
  cliOverrides: CliOverrides,
  workspacePackages: string[],
  fetchLatencyMs?: number,
  fallbackReason?: BootstrapFallbackReason,
): BootstrapResult {
  const cliScopeProvided = (cliOverrides.scope ?? []).length > 0;

  let scopeInferenceMethod: BootstrapScopeInferenceMethod;
  let inferredScope: string[];
  let resolvedScope: string[];

  if (cliScopeProvided) {
    scopeInferenceMethod = 'explicit';
    inferredScope = [];
    resolvedScope = cliOverrides.scope!;
  } else if (issue) {
    inferredScope = inferScopeFromText(issue.descriptionText ?? '', workspacePackages);
    scopeInferenceMethod = inferredScope.length > 0 ? 'deterministic' : 'empty';
    resolvedScope = inferredScope;
  } else {
    scopeInferenceMethod = 'empty';
    inferredScope = [];
    resolvedScope = [];
  }

  const title = cliOverrides.title ?? issue?.summary ?? jiraKey;
  const descriptionFromJira =
    issue?.descriptionText && issue.descriptionText.length > 0 ? issue.descriptionText : undefined;
  const description = cliOverrides.description ?? descriptionFromJira ?? jiraKey;

  const acceptanceCriteria = issue?.descriptionText
    ? extractAcceptanceCriteria(issue.descriptionText)
    : [];

  const bootstrapMeta: BootstrapMeta = {
    jiraKey,
    jiraFetchSuccess: issue !== null,
    inferredScope,
    scopeInferenceMethod,
  };
  if (fetchLatencyMs !== undefined) {
    bootstrapMeta.jiraFetchLatencyMs = fetchLatencyMs;
  }
  if (issue === null && fallbackReason !== undefined) {
    bootstrapMeta.fallbackReason = fallbackReason;
  }
  if (acceptanceCriteria.length > 0) {
    bootstrapMeta.acceptanceCriteria = acceptanceCriteria;
  }

  return {
    partialWorkItem: {
      title,
      description,
      scope: resolvedScope,
      jiraKey,
    },
    bootstrapMeta,
  };
}

// ─── Stderr Logging Helpers ──────────────────────────────────────

const PREFIX = '[helix:jira]';

/** Single bootstrap stderr line with summary + description sizes + scope. */
export function formatBootstrapSuccessLine(
  jiraKey: string,
  fetchLatencyMs: number,
  summaryLen: number,
  descriptionLen: number,
  inferredScope: string[],
): string {
  const scope = inferredScope.length > 0 ? inferredScope.join(', ') : 'none';
  return `${PREFIX} fetched ${jiraKey} (${fetchLatencyMs} ms, summary: ${summaryLen} chars, description: ${descriptionLen} chars, inferred scope: ${scope})`;
}

/** Single failure stderr line naming the fallback reason. */
export function formatBootstrapFailureLine(
  jiraKey: string,
  reason: BootstrapFallbackReason,
): string {
  return `${PREFIX} ${jiraKey} ${reason} — proceeding without enrichment`;
}
