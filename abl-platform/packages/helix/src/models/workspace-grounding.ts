import { homedir } from 'node:os';
import { normalize, relative, resolve, sep } from 'node:path';

import type { WorkspaceExecutionContext } from '../types.js';

export interface WorkspacePathReplacement {
  from: string;
  to: string;
}

export function shouldGuardWorkspacePaths(workspaceContext?: WorkspaceExecutionContext): boolean {
  return workspaceContext?.mode === 'git-worktree';
}

export function buildWorkspacePathReplacements(
  workDir: string,
  workspaceContext?: WorkspaceExecutionContext,
): WorkspacePathReplacement[] {
  const sourceWorkDir =
    workspaceContext?.mode === 'git-worktree' ? workspaceContext.sourceWorkDir?.trim() : undefined;
  if (!sourceWorkDir) {
    return [];
  }

  const normalizedSourceWorkDir = normalize(resolve(sourceWorkDir));
  const normalizedWorkDir = normalize(resolve(workDir));
  if (normalizedSourceWorkDir === normalizedWorkDir) {
    return [];
  }

  const replacements: WorkspacePathReplacement[] = [
    {
      from: normalizedSourceWorkDir,
      to: normalizedWorkDir,
    },
  ];
  const homeRelativeSource = toHomeRelativePath(normalizedSourceWorkDir);
  const homeRelativeWorkDir = toHomeRelativePath(normalizedWorkDir);
  if (homeRelativeSource && homeRelativeWorkDir) {
    replacements.push({
      from: homeRelativeSource,
      to: homeRelativeWorkDir,
    });
  }

  return replacements.sort((left, right) => right.from.length - left.from.length);
}

export function rewriteTextToExecutionWorkspace(
  text: string,
  workDir: string,
  workspaceContext?: WorkspaceExecutionContext,
): string {
  const replacements = buildWorkspacePathReplacements(workDir, workspaceContext);
  if (replacements.length === 0) {
    return text;
  }

  let rewritten = text;
  for (const replacement of replacements) {
    rewritten = replaceWorkspacePathTokens(rewritten, replacement);
  }

  return rewritten;
}

export function buildSourceWorkspaceAliases(
  workspaceContext?: WorkspaceExecutionContext,
): string[] {
  const sourceWorkDir =
    workspaceContext?.mode === 'git-worktree' ? workspaceContext.sourceWorkDir?.trim() : undefined;
  if (!sourceWorkDir) {
    return [];
  }

  const normalizedSourceWorkDir = normalize(resolve(sourceWorkDir));
  const aliases = new Set<string>([normalizedSourceWorkDir]);
  const homeRelativeSource = toHomeRelativePath(normalizedSourceWorkDir);
  if (homeRelativeSource) {
    aliases.add(homeRelativeSource);
  }

  return [...aliases];
}

export function findSourceWorkspaceAliasInText(
  text: string,
  sourceAliases: string[],
): string | undefined {
  if (sourceAliases.length === 0) {
    return undefined;
  }

  // Boundary-aware match. A naked `text.includes(alias)` produces false
  // positives when the alias is a prefix of an unrelated path — for
  // example, source `/Users/x/repo` matches the worktree
  // `/Users/x/repo-wt-branch-review-...` because the worktree path
  // legitimately starts with the same prefix. We require the next
  // character after the match to be either end-of-string or a path
  // separator / known token boundary, so `repo-wt-...` no longer
  // triggers when the alias is `repo`.
  return sourceAliases.find((alias) => containsAliasAtBoundary(text, alias));
}

function containsAliasAtBoundary(text: string, alias: string): boolean {
  if (alias.length === 0) return false;
  let cursor = 0;
  while (cursor <= text.length - alias.length) {
    const matchIndex = text.indexOf(alias, cursor);
    if (matchIndex === -1) return false;
    const nextIndex = matchIndex + alias.length;
    const previousChar = matchIndex > 0 ? text[matchIndex - 1] : '';
    const nextChar = nextIndex < text.length ? text[nextIndex] : '';
    const precededByBoundary = previousChar === '' || /[\s"'`([{=,:]/.test(previousChar);
    const followedByBoundary = nextChar === '' || /[\\/\s"'`)\]}=,:;]/.test(nextChar);
    if (precededByBoundary && followedByBoundary) {
      return true;
    }
    cursor = matchIndex + 1;
  }
  return false;
}

function replaceWorkspacePathTokens(value: string, replacement: WorkspacePathReplacement): string {
  if (!value.includes(replacement.from)) {
    return value;
  }

  let cursor = 0;
  let rewritten = '';

  while (cursor < value.length) {
    const matchIndex = value.indexOf(replacement.from, cursor);
    if (matchIndex === -1) {
      rewritten += value.slice(cursor);
      break;
    }

    const nextIndex = matchIndex + replacement.from.length;
    const previousChar = matchIndex > 0 ? value[matchIndex - 1] : '';
    const nextChar = nextIndex < value.length ? value[nextIndex] : '';

    const precededByBoundary = previousChar === '' || /[\s"'`([{=,:]/.test(previousChar);
    const followedByBoundary = nextChar === '' || /[\\/\s"'`)\]}=,:;]/.test(nextChar);

    rewritten += value.slice(cursor, matchIndex);
    if (precededByBoundary && followedByBoundary) {
      rewritten += replacement.to;
    } else {
      rewritten += replacement.from;
    }

    cursor = nextIndex;
  }

  return rewritten;
}

function toHomeRelativePath(value: string): string | undefined {
  const homeDir = homedir();
  const normalizedHome = normalize(resolve(homeDir));
  if (value === normalizedHome) {
    return '~';
  }

  if (!value.startsWith(`${normalizedHome}${sep}`)) {
    return undefined;
  }

  return `~/${relative(normalizedHome, value)}`;
}
