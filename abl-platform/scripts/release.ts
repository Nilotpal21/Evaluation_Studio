#!/usr/bin/env npx tsx
/**
 * Release Orchestration CLI
 *
 * Manages the release lifecycle for the ABL Platform monorepo using
 * CalVer (YYYY.MM.patch) versioning.
 *
 * Usage:
 *   tsx scripts/release.ts cut                     # Create release branch from develop
 *   tsx scripts/release.ts finalize                # Merge release to main, tag, CHANGELOG, Jira
 *   tsx scripts/release.ts hotfix create           # Branch from main
 *   tsx scripts/release.ts hotfix finalize         # Merge hotfix to main + develop
 *   tsx scripts/release.ts status                  # Dashboard of release state
 *   tsx scripts/release.ts changelog [--from tag]  # Generate CHANGELOG
 *
 * Flags:
 *   --dry-run     Print actions without executing
 *   --skip-jira   Skip all Jira API calls
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { JiraClient } from './jira-client.js';
import type { TicketSummary } from './jira-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'ABLP';

// Commit type labels for CHANGELOG grouping
const TYPE_LABELS: Record<string, string> = {
  feat: 'Features',
  fix: 'Bug Fixes',
  perf: 'Performance',
  refactor: 'Refactoring',
  docs: 'Documentation',
  test: 'Tests',
  chore: 'Chores',
  ci: 'CI/CD',
  build: 'Build',
  style: 'Style',
  revert: 'Reverts',
};

// ---------------------------------------------------------------------------
// Colors (for terminal output)
// ---------------------------------------------------------------------------

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[0;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

// ---------------------------------------------------------------------------
// CLI Flags
// ---------------------------------------------------------------------------

interface CliFlags {
  dryRun: boolean;
  skipJira: boolean;
  fromTag: string | null;
}

function parseFlags(args: string[]): { command: string; flags: CliFlags } {
  const flags: CliFlags = { dryRun: false, skipJira: false, fromTag: null };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--skip-jira') {
      flags.skipJira = true;
    } else if (arg === '--from' && i + 1 < args.length) {
      flags.fromTag = args[++i];
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  return { command: positional.join(' '), flags };
}

// ---------------------------------------------------------------------------
// Git Helpers
// ---------------------------------------------------------------------------

function git(cmd: string, options?: { allowFailure?: boolean }): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (options?.allowFailure) return '';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${RED}git ${cmd} failed:${NC} ${message}`);
    process.exit(1);
  }
}

function gitExec(cmd: string, dryRun: boolean, label?: string): string {
  const display = label ?? `git ${cmd}`;
  if (dryRun) {
    console.log(`${DIM}  [dry-run] ${display}${NC}`);
    return '';
  }
  console.log(`${DIM}  ${display}${NC}`);
  return git(cmd);
}

function getCurrentBranch(): string {
  return git('rev-parse --abbrev-ref HEAD');
}

function getLatestTag(): string | null {
  const tag = git('describe --tags --abbrev=0', { allowFailure: true });
  return tag || null;
}

function isCleanTree(): boolean {
  const status = git('status --porcelain');
  return status === '';
}

function assertCleanTree(): void {
  if (!isCleanTree()) {
    console.error(`${RED}Working tree is not clean. Commit or stash changes first.${NC}`);
    process.exit(1);
  }
}

function assertBranch(expected: string): void {
  const current = getCurrentBranch();
  if (current !== expected) {
    console.error(`${RED}Expected branch "${expected}", but on "${current}".${NC}`);
    process.exit(1);
  }
}

function assertBranchPrefix(prefix: string): string {
  const current = getCurrentBranch();
  if (!current.startsWith(prefix)) {
    console.error(`${RED}Expected branch starting with "${prefix}", but on "${current}".${NC}`);
    process.exit(1);
  }
  return current;
}

function branchExists(name: string): boolean {
  const result = git(`branch --list ${name}`, { allowFailure: true });
  return result !== '';
}

function remoteBranchExists(name: string): boolean {
  const result = git(`ls-remote --heads origin ${name}`, {
    allowFailure: true,
  });
  return result !== '';
}

// ---------------------------------------------------------------------------
// Version Helpers
// ---------------------------------------------------------------------------

interface CalVer {
  year: number;
  month: number;
  patch: number;
}

function parseCalVer(version: string): CalVer | null {
  const stripped = version.startsWith('v') ? version.slice(1) : version;
  const match = stripped.match(/^(\d{4})\.(\d{1,2})\.(\d+)$/);
  if (!match) return null;
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function formatCalVer(v: CalVer): string {
  return `${v.year}.${String(v.month).padStart(2, '0')}.${v.patch}`;
}

function computeNextVersion(latestTag: string | null): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  if (!latestTag) {
    return formatCalVer({ year, month, patch: 0 });
  }

  const parsed = parseCalVer(latestTag);
  if (!parsed) {
    return formatCalVer({ year, month, patch: 0 });
  }

  if (parsed.year === year && parsed.month === month) {
    return formatCalVer({ year, month, patch: parsed.patch + 1 });
  }

  return formatCalVer({ year, month, patch: 0 });
}

function computeNextPatch(latestTag: string): string {
  const parsed = parseCalVer(latestTag);
  if (!parsed) {
    const now = new Date();
    return formatCalVer({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      patch: 0,
    });
  }
  return formatCalVer({
    year: parsed.year,
    month: parsed.month,
    patch: parsed.patch + 1,
  });
}

function readPackageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
  return pkg.version as string;
}

function bumpPackageVersion(version: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`${DIM}  [dry-run] Bump package.json version to ${version}${NC}`);
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
  pkg.version = version;
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${DIM}  Bumped package.json to ${version}${NC}`);
}

// ---------------------------------------------------------------------------
// Commit Log Parsing
// ---------------------------------------------------------------------------

interface ParsedCommit {
  hash: string;
  ticket: string | null;
  type: string;
  scope: string | null;
  subject: string;
}

function getCommitsSinceTag(tag: string | null): ParsedCommit[] {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const log = git(`log ${range} --format=%H|%s`, { allowFailure: true });
  if (!log) return [];

  const commits: ParsedCommit[] = [];
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    const pipeIdx = line.indexOf('|');
    if (pipeIdx === -1) continue;
    const hash = line.slice(0, pipeIdx);
    const subject = line.slice(pipeIdx + 1);

    // Parse: [ABLP-123] type(scope): description
    const match = subject.match(/^\[([A-Z]+-\d+)\]\s*(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
    if (match) {
      commits.push({
        hash,
        ticket: match[1],
        type: match[2],
        scope: match[3] ?? null,
        subject: match[4],
      });
    } else {
      commits.push({
        hash,
        ticket: null,
        type: 'other',
        scope: null,
        subject,
      });
    }
  }
  return commits;
}

function extractTicketKeys(commits: ParsedCommit[]): string[] {
  const keys = new Set<string>();
  for (const c of commits) {
    if (c.ticket) keys.add(c.ticket);
  }
  return Array.from(keys);
}

// ---------------------------------------------------------------------------
// CHANGELOG Generation
// ---------------------------------------------------------------------------

async function generateChangelog(
  version: string,
  fromTag: string | null,
  jira: JiraClient,
  skipJira: boolean,
): Promise<string> {
  const commits = getCommitsSinceTag(fromTag);
  if (commits.length === 0) {
    return `## ${version}\n\nNo changes.\n`;
  }

  // Group by type
  const grouped = new Map<string, ParsedCommit[]>();
  for (const c of commits) {
    const key = c.type;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }

  // Fetch Jira summaries if available
  let summaryMap = new Map<string, string>();
  if (!skipJira && jira.isConfigured()) {
    const ticketKeys = extractTicketKeys(commits);
    const result = await jira.getTicketSummaries(ticketKeys);
    if (result.success && result.data) {
      for (const s of result.data) {
        summaryMap.set(s.key, s.summary);
      }
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`## ${version} (${date})`, ''];

  // Output in a predictable order
  const typeOrder = [
    'feat',
    'fix',
    'perf',
    'refactor',
    'docs',
    'test',
    'chore',
    'ci',
    'build',
    'style',
    'revert',
    'other',
  ];

  for (const type of typeOrder) {
    const group = grouped.get(type);
    if (!group || group.length === 0) continue;

    const label = TYPE_LABELS[type] ?? type;
    lines.push(`### ${label}`, '');

    for (const c of group) {
      const scopeStr = c.scope ? `**${c.scope}:** ` : '';
      const ticketStr = c.ticket ? `[${c.ticket}] ` : '';
      const jiraSummary =
        c.ticket && summaryMap.has(c.ticket) ? ` — ${summaryMap.get(c.ticket)}` : '';
      lines.push(`- ${ticketStr}${scopeStr}${c.subject}${jiraSummary} (${c.hash.slice(0, 7)})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function prependToChangelog(content: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`${DIM}  [dry-run] Prepend CHANGELOG.md${NC}`);
    console.log(
      `${DIM}${content
        .split('\n')
        .slice(0, 10)
        .map((l) => `    ${l}`)
        .join('\n')}${NC}`,
    );
    return;
  }

  let existing = '';
  if (fs.existsSync(CHANGELOG_PATH)) {
    existing = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
  }

  const header = '# Changelog\n\n';
  const body = existing.startsWith('# Changelog')
    ? existing.replace(/^# Changelog\n+/, '')
    : existing;

  fs.writeFileSync(CHANGELOG_PATH, `${header}${content}\n${body}`);
  console.log(`${DIM}  Updated CHANGELOG.md${NC}`);
}

// ---------------------------------------------------------------------------
// Jira Helpers
// ---------------------------------------------------------------------------

async function jiraCreateAndSetFixVersion(
  jira: JiraClient,
  version: string,
  ticketKeys: string[],
  dryRun: boolean,
  skipJira: boolean,
): Promise<void> {
  if (skipJira || !jira.isConfigured()) {
    if (!skipJira) {
      console.log(`${YELLOW}  Jira not configured — skipping fix version creation${NC}`);
    } else {
      console.log(`${DIM}  [skip-jira] Skipping fix version creation${NC}`);
    }
    return;
  }

  if (dryRun) {
    console.log(
      `${DIM}  [dry-run] Create Jira fix version ${version} and assign to ${ticketKeys.length} tickets${NC}`,
    );
    return;
  }

  // Create or find fix version
  let versionId: string | null = null;
  const existing = await jira.getFixVersion(JIRA_PROJECT_KEY, version);
  if (existing.success && existing.data) {
    versionId = existing.data.id;
    console.log(`${DIM}  Jira fix version "${version}" already exists (${versionId})${NC}`);
  } else {
    const created = await jira.createFixVersion(JIRA_PROJECT_KEY, version);
    if (created.success && created.data) {
      versionId = created.data.id;
      console.log(`${DIM}  Created Jira fix version "${version}" (${versionId})${NC}`);
    } else {
      console.error(
        `${YELLOW}  Warning: Could not create Jira fix version: ${created.error?.message}${NC}`,
      );
      return;
    }
  }

  // Assign fix version to tickets
  for (const key of ticketKeys) {
    const result = await jira.setFixVersion(key, versionId);
    if (result.success) {
      console.log(`${DIM}  Set fix version on ${key}${NC}`);
    } else {
      console.error(
        `${YELLOW}  Warning: Could not set fix version on ${key}: ${result.error?.message}${NC}`,
      );
    }
  }
}

async function jiraReleaseFixVersion(
  jira: JiraClient,
  version: string,
  dryRun: boolean,
  skipJira: boolean,
): Promise<void> {
  if (skipJira || !jira.isConfigured()) {
    if (!skipJira) {
      console.log(`${YELLOW}  Jira not configured — skipping fix version release${NC}`);
    } else {
      console.log(`${DIM}  [skip-jira] Skipping fix version release${NC}`);
    }
    return;
  }

  if (dryRun) {
    console.log(`${DIM}  [dry-run] Release Jira fix version ${version}${NC}`);
    return;
  }

  const existing = await jira.getFixVersion(JIRA_PROJECT_KEY, version);
  if (!existing.success || !existing.data) {
    console.error(
      `${YELLOW}  Warning: Could not find Jira fix version "${version}" to release${NC}`,
    );
    return;
  }

  const result = await jira.releaseFixVersion(existing.data.id);
  if (result.success) {
    console.log(`${DIM}  Released Jira fix version "${version}"${NC}`);
  } else {
    console.error(
      `${YELLOW}  Warning: Could not release Jira fix version: ${result.error?.message}${NC}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdCut(flags: CliFlags): Promise<void> {
  const { dryRun, skipJira } = flags;
  const jira = new JiraClient();

  console.log(`\n${BOLD}${CYAN}Release Cut${NC}\n`);

  // Assertions
  assertBranch('develop');
  assertCleanTree();

  // Compute version
  const latestTag = getLatestTag();
  const version = computeNextVersion(latestTag);
  const branchName = `release/${version}`;

  console.log(`${BOLD}  Latest tag:${NC}    ${latestTag ?? '(none)'}`);
  console.log(`${BOLD}  New version:${NC}   ${version}`);
  console.log(`${BOLD}  Branch:${NC}        ${branchName}`);
  console.log('');

  // Check branch doesn't already exist
  if (branchExists(branchName) || remoteBranchExists(branchName)) {
    console.error(`${RED}Branch "${branchName}" already exists.${NC}`);
    process.exit(1);
  }

  // Create branch
  gitExec(`checkout -b ${branchName}`, dryRun);

  // Bump version
  bumpPackageVersion(version, dryRun);

  // Commit
  gitExec(`add ${PACKAGE_JSON_PATH}`, dryRun, 'git add package.json');
  gitExec(`commit -m "[ABLP-0] chore(ci): bump version to ${version}"`, dryRun);

  // Push (with ABL_RELEASE=1 to bypass pre-push branch protection)
  if (!dryRun) {
    console.log(`${DIM}  ABL_RELEASE=1 git push -u origin ${branchName}${NC}`);
    try {
      execSync(`ABL_RELEASE=1 git push -u origin ${branchName}`, {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: 'inherit',
      });
    } catch {
      console.error(`${YELLOW}  Warning: Push failed (remote may not be available)${NC}`);
    }
  } else {
    console.log(`${DIM}  [dry-run] ABL_RELEASE=1 git push -u origin ${branchName}${NC}`);
  }

  // Jira: create fix version and assign tickets
  const commits = getCommitsSinceTag(latestTag);
  const ticketKeys = extractTicketKeys(commits);
  console.log(`\n${BOLD}  Tickets in release:${NC} ${ticketKeys.length}`);
  if (ticketKeys.length > 0) {
    console.log(`  ${ticketKeys.join(', ')}`);
  }
  await jiraCreateAndSetFixVersion(jira, version, ticketKeys, dryRun, skipJira);

  console.log(`\n${GREEN}${BOLD}Release branch "${branchName}" created.${NC}`);
  console.log(`  Next: QA on the release branch, then run: apx release finalize\n`);
}

async function cmdFinalize(flags: CliFlags): Promise<void> {
  const { dryRun, skipJira } = flags;
  const jira = new JiraClient();

  console.log(`\n${BOLD}${CYAN}Release Finalize${NC}\n`);

  // Assert on release branch
  const branch = assertBranchPrefix('release/');
  const version = branch.replace('release/', '');
  const tag = `v${version}`;

  assertCleanTree();

  console.log(`${BOLD}  Branch:${NC}   ${branch}`);
  console.log(`${BOLD}  Version:${NC}  ${version}`);
  console.log(`${BOLD}  Tag:${NC}      ${tag}`);
  console.log('');

  // Merge to main (--no-ff)
  gitExec('checkout main', dryRun);
  gitExec(`merge --no-ff ${branch} -m "Merge ${branch} to main"`, dryRun);

  // Tag
  gitExec(`tag -a ${tag} -m "Release ${version}"`, dryRun);

  // Merge back to develop
  gitExec('checkout develop', dryRun);
  gitExec(`merge --no-ff main -m "Merge main back to develop after release ${version}"`, dryRun);

  // Delete release branch
  gitExec(`branch -D ${branch}`, dryRun);

  // Generate CHANGELOG
  const latestTag = getLatestTag();
  const prevTag = git(`describe --tags --abbrev=0 ${tag}^`, { allowFailure: true }) || null;
  const changelogContent = await generateChangelog(version, prevTag, jira, skipJira);
  prependToChangelog(changelogContent, dryRun);

  if (!dryRun) {
    gitExec(`add ${CHANGELOG_PATH}`, false, 'git add CHANGELOG.md');
    gitExec(`commit -m "[ABLP-0] docs(ci): update CHANGELOG for ${version}"`, false);
  }

  // Push everything
  if (!dryRun) {
    try {
      execSync('ABL_RELEASE=1 git push origin main --follow-tags', {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: 'inherit',
      });
      execSync('ABL_RELEASE=1 git push origin develop', {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: 'inherit',
      });
    } catch {
      console.error(`${YELLOW}  Warning: Push failed (remote may not be available)${NC}`);
    }

    // Delete remote release branch
    git(`push origin --delete ${branch}`, { allowFailure: true });
  } else {
    console.log(`${DIM}  [dry-run] Push main + tags, push develop, delete remote ${branch}${NC}`);
  }

  // Jira: release fix version
  await jiraReleaseFixVersion(jira, version, dryRun, skipJira);

  console.log(`\n${GREEN}${BOLD}Release ${version} finalized.${NC}\n`);
}

async function cmdHotfixCreate(flags: CliFlags): Promise<void> {
  const { dryRun } = flags;

  console.log(`\n${BOLD}${CYAN}Hotfix Create${NC}\n`);

  assertBranch('main');
  assertCleanTree();

  const latestTag = getLatestTag();
  if (!latestTag) {
    console.error(
      `${RED}No existing tags found. Cannot create hotfix without a prior release.${NC}`,
    );
    process.exit(1);
  }

  const version = computeNextPatch(latestTag);
  const branchName = `hotfix/${version}`;

  console.log(`${BOLD}  Latest tag:${NC}    ${latestTag}`);
  console.log(`${BOLD}  Hotfix version:${NC} ${version}`);
  console.log(`${BOLD}  Branch:${NC}        ${branchName}`);
  console.log('');

  if (branchExists(branchName) || remoteBranchExists(branchName)) {
    console.error(`${RED}Branch "${branchName}" already exists.${NC}`);
    process.exit(1);
  }

  gitExec(`checkout -b ${branchName}`, dryRun);
  bumpPackageVersion(version, dryRun);
  gitExec(`add ${PACKAGE_JSON_PATH}`, dryRun, 'git add package.json');
  gitExec(`commit -m "[ABLP-0] chore(ci): bump version to ${version}"`, dryRun);

  if (!dryRun) {
    try {
      execSync(`ABL_RELEASE=1 git push -u origin ${branchName}`, {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: 'inherit',
      });
    } catch {
      console.error(`${YELLOW}  Warning: Push failed (remote may not be available)${NC}`);
    }
  } else {
    console.log(`${DIM}  [dry-run] ABL_RELEASE=1 git push -u origin ${branchName}${NC}`);
  }

  console.log(`\n${GREEN}${BOLD}Hotfix branch "${branchName}" created.${NC}`);
  console.log(`  Next: Apply fix, then run: apx hotfix finalize\n`);
}

async function cmdHotfixFinalize(flags: CliFlags): Promise<void> {
  const { dryRun, skipJira } = flags;
  const jira = new JiraClient();

  console.log(`\n${BOLD}${CYAN}Hotfix Finalize${NC}\n`);

  const branch = assertBranchPrefix('hotfix/');
  const version = branch.replace('hotfix/', '');
  const tag = `v${version}`;

  assertCleanTree();

  console.log(`${BOLD}  Branch:${NC}   ${branch}`);
  console.log(`${BOLD}  Version:${NC}  ${version}`);
  console.log(`${BOLD}  Tag:${NC}      ${tag}`);
  console.log('');

  // Merge to main
  gitExec('checkout main', dryRun);
  gitExec(`merge --no-ff ${branch} -m "Merge ${branch} to main"`, dryRun);

  // Tag
  gitExec(`tag -a ${tag} -m "Hotfix ${version}"`, dryRun);

  // Merge to develop
  gitExec('checkout develop', dryRun);
  gitExec(`merge --no-ff main -m "Merge main back to develop after hotfix ${version}"`, dryRun);

  // Delete hotfix branch
  gitExec(`branch -D ${branch}`, dryRun);

  // CHANGELOG
  const prevTag = git(`describe --tags --abbrev=0 ${tag}^`, { allowFailure: true }) || null;
  const changelogContent = await generateChangelog(version, prevTag, jira, skipJira);
  prependToChangelog(changelogContent, dryRun);

  if (!dryRun) {
    gitExec(`add ${CHANGELOG_PATH}`, false, 'git add CHANGELOG.md');
    gitExec(`commit -m "[ABLP-0] docs(ci): update CHANGELOG for hotfix ${version}"`, false);
  }

  // Push
  if (!dryRun) {
    try {
      execSync('ABL_RELEASE=1 git push origin main --follow-tags', {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: 'inherit',
      });
      execSync('ABL_RELEASE=1 git push origin develop', {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: 'inherit',
      });
    } catch {
      console.error(`${YELLOW}  Warning: Push failed (remote may not be available)${NC}`);
    }

    git(`push origin --delete ${branch}`, { allowFailure: true });
  } else {
    console.log(`${DIM}  [dry-run] Push main + tags, push develop, delete remote ${branch}${NC}`);
  }

  // Jira
  await jiraReleaseFixVersion(jira, version, dryRun, skipJira);

  console.log(`\n${GREEN}${BOLD}Hotfix ${version} finalized.${NC}\n`);
}

function cmdStatus(): void {
  console.log(`\n${BOLD}${CYAN}=== Release Status ===${NC}\n`);

  const currentBranch = getCurrentBranch();
  const currentVersion = readPackageVersion();
  const latestTag = getLatestTag();

  console.log(`${BOLD}  Current branch:${NC}  ${currentBranch}`);
  console.log(`${BOLD}  package.json:${NC}    ${currentVersion}`);
  console.log(`${BOLD}  Latest tag:${NC}      ${latestTag ?? '(none)'}`);
  console.log('');

  // Release branches
  const releaseBranches = git('branch -a --list *release/*', {
    allowFailure: true,
  });
  const hotfixBranches = git('branch -a --list *hotfix/*', {
    allowFailure: true,
  });

  if (releaseBranches) {
    console.log(`${BOLD}  Release branches:${NC}`);
    for (const b of releaseBranches.split('\n').filter(Boolean)) {
      console.log(`    ${b.trim()}`);
    }
  } else {
    console.log(`${DIM}  No active release branches${NC}`);
  }

  if (hotfixBranches) {
    console.log(`${BOLD}  Hotfix branches:${NC}`);
    for (const b of hotfixBranches.split('\n').filter(Boolean)) {
      console.log(`    ${b.trim()}`);
    }
  } else {
    console.log(`${DIM}  No active hotfix branches${NC}`);
  }

  console.log('');

  // Pending commits since last tag
  const commits = getCommitsSinceTag(latestTag);
  console.log(`${BOLD}  Commits since last tag:${NC} ${commits.length}`);

  if (commits.length > 0) {
    const ticketKeys = extractTicketKeys(commits);
    console.log(`${BOLD}  Tickets:${NC} ${ticketKeys.length}`);
    if (ticketKeys.length > 0) {
      console.log(`    ${ticketKeys.join(', ')}`);
    }
    console.log('');

    // Show recent commits (last 10)
    const recent = commits.slice(0, 10);
    console.log(`${BOLD}  Recent commits:${NC}`);
    for (const c of recent) {
      const ticket = c.ticket ? `[${c.ticket}] ` : '';
      const scope = c.scope ? `(${c.scope}) ` : '';
      console.log(`    ${DIM}${c.hash.slice(0, 7)}${NC} ${ticket}${c.type}${scope}: ${c.subject}`);
    }
    if (commits.length > 10) {
      console.log(`    ${DIM}... and ${commits.length - 10} more${NC}`);
    }
  }

  // Next version preview
  const nextVersion = computeNextVersion(latestTag);
  console.log(`\n${BOLD}  Next version:${NC}    ${nextVersion}`);

  console.log('');
}

async function cmdChangelog(flags: CliFlags): Promise<void> {
  const { fromTag, skipJira, dryRun } = flags;
  const jira = new JiraClient();

  console.log(`\n${BOLD}${CYAN}Generate CHANGELOG${NC}\n`);

  const latestTag = fromTag ?? getLatestTag();
  const version = readPackageVersion();

  console.log(`${BOLD}  From tag:${NC}  ${latestTag ?? '(none)'}`);
  console.log(`${BOLD}  Version:${NC}   ${version}`);
  console.log('');

  const content = await generateChangelog(version, latestTag, jira, skipJira);
  prependToChangelog(content, dryRun);

  if (!dryRun) {
    console.log(`\n${GREEN}CHANGELOG.md updated.${NC}\n`);
  } else {
    console.log(`\n${GREEN}[dry-run] CHANGELOG generation complete.${NC}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, flags } = parseFlags(args);

  if (flags.dryRun) {
    console.log(`${YELLOW}${BOLD}DRY RUN MODE — no changes will be made${NC}`);
  }

  switch (command) {
    case 'cut':
      await cmdCut(flags);
      break;
    case 'finalize':
      await cmdFinalize(flags);
      break;
    case 'hotfix create':
      await cmdHotfixCreate(flags);
      break;
    case 'hotfix finalize':
      await cmdHotfixFinalize(flags);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'changelog':
      await cmdChangelog(flags);
      break;
    default:
      console.log(`${BOLD}${CYAN}ABL Platform Release Manager${NC}\n`);
      console.log('Usage:');
      console.log('  release cut                   Create release branch from develop');
      console.log('  release finalize              Merge release to main, tag, CHANGELOG, Jira');
      console.log('  release hotfix create         Branch from main for urgent fix');
      console.log('  release hotfix finalize       Merge hotfix to main + develop, tag');
      console.log('  release status                Show current release state');
      console.log('  release changelog [--from tag] Generate CHANGELOG');
      console.log('');
      console.log('Flags:');
      console.log('  --dry-run     Print actions without executing');
      console.log('  --skip-jira   Skip all Jira API calls');
      console.log('');
      break;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${RED}Fatal: ${message}${NC}`);
  process.exit(1);
});
