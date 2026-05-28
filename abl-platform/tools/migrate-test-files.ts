#!/usr/bin/env npx tsx
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ROOT = resolve(__dirname, '..');
const RUNTIME_TEST_ROOT = join(ROOT, 'apps', 'runtime', 'src', '__tests__');
const RUNTIME_APP_ROOT = join(ROOT, 'apps', 'runtime');
const STUDIO_TEST_ROOT = join(ROOT, 'apps', 'studio', 'src', '__tests__');
const STUDIO_APP_ROOT = join(ROOT, 'apps', 'studio');

const CODE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const REFERENCE_CALLEES = new Set([
  'import',
  'jest.doMock',
  'jest.mock',
  'mock.module',
  'require',
  'vi.doMock',
  'vi.mock',
]);

type MigrationPlanName = 'runtime-phase2' | 'runtime-phase3' | 'studio-phase4';

interface DirectoryRule {
  from: string;
  kind: 'directory';
  to: string;
}

interface RootFileRule {
  exact?: string[];
  kind: 'root-file';
  prefixes?: string[];
  regexes?: RegExp[];
  to: string;
}

interface FileRule {
  from: string;
  kind: 'file';
  to: string;
}

type MigrationRule = DirectoryRule | FileRule | RootFileRule;

interface MigrationPlan {
  appRoot: string;
  name: MigrationPlanName;
  referenceFiles: string[];
  rules: MigrationRule[];
  testRoot: string;
}

export interface FileMove {
  fromAbsolute: string;
  fromRelative: string;
  toAbsolute: string;
  toRelative: string;
}

interface CliOptions {
  apply: boolean;
  plan: MigrationPlanName;
}

const MIGRATION_PLAN_NAMES = ['runtime-phase2', 'runtime-phase3', 'studio-phase4'] as const;

const PLANS: Record<MigrationPlanName, MigrationPlan> = {
  'runtime-phase2': {
    appRoot: RUNTIME_APP_ROOT,
    name: 'runtime-phase2',
    referenceFiles: [
      'apps/runtime/agents.md',
      'apps/runtime/vitest.config.ts',
      'apps/runtime/vitest.e2e.config.ts',
      'apps/runtime/vitest.fast.config.ts',
      'apps/runtime/vitest.flaky.config.ts',
      'apps/runtime/vitest.integration.config.ts',
      'apps/runtime/vitest.sdk-auth.config.ts',
      'apps/runtime/vitest.smoke.config.ts',
    ],
    rules: [
      {
        exact: ['auth-preflight.test.ts', 'middleware.test.ts'],
        kind: 'root-file',
        prefixes: ['auth-profile-', 'encryption-', 'kms-', 'middleware-', 'sdk-', 'user-isolation'],
        regexes: [/-authz(?:\.|-)/],
        to: 'auth',
      },
      { from: 'auth-profile', kind: 'directory', to: 'auth/auth-profile' },
      { from: 'middleware', kind: 'directory', to: 'auth/middleware' },

      {
        exact: ['typing-indicators.test.ts', 'webhook-url-generation.test.ts'],
        kind: 'root-file',
        prefixes: [
          'channel-',
          'channels-',
          'email-',
          'livekit-',
          'omnichannel-',
          'voice-',
          'websocket-',
          'ws-',
        ],
        to: 'channels',
      },
      { from: 'adapters', kind: 'directory', to: 'channels/adapters' },
      { from: 'email', kind: 'directory', to: 'channels/email' },
      { from: 'webhooks', kind: 'directory', to: 'channels/webhooks' },
      { from: 'websocket', kind: 'directory', to: 'channels/websocket' },

      {
        exact: [
          'executor-integration.test.ts',
          'project-config-handoff.test.ts',
          'rich-content-execution.test.ts',
          'runtime-completion.test.ts',
          'scripted-mode-handoff-fix.unit.test.ts',
          'thread-resume-integration.test.ts',
          'thread-resume.test.ts',
          'thread-sync-functions.test.ts',
          'validation-retry.test.ts',
          'value-resolution.test.ts',
        ],
        kind: 'root-file',
        prefixes: ['execution-', 'flow-', 'handoff-', 'reasoning-', 'runtime-executor'],
        to: 'execution',
      },
      { from: 'contexts', kind: 'directory', to: 'execution/contexts' },
      { from: 'event-bus', kind: 'directory', to: 'execution/event-bus' },
      { from: 'guardrails', kind: 'directory', to: 'execution/guardrails' },
      { from: 'pre-refactor', kind: 'directory', to: 'execution/pre-refactor' },

      {
        exact: ['cb-persistence-observability.test.ts'],
        kind: 'root-file',
        prefixes: ['circuit-breaker-', 'clickhouse-', 'observatory-', 'trace-', 'tracer-'],
        to: 'observability',
      },
      { from: 'tracing', kind: 'directory', to: 'observability/tracing' },
    ],
    testRoot: RUNTIME_TEST_ROOT,
  },
  'runtime-phase3': {
    appRoot: RUNTIME_APP_ROOT,
    name: 'runtime-phase3',
    referenceFiles: [
      'apps/runtime/agents.md',
      'apps/runtime/package.json',
      'apps/runtime/vitest.config.ts',
      'apps/runtime/vitest.e2e.config.ts',
      'apps/runtime/vitest.fast.config.ts',
      'apps/runtime/vitest.flaky.config.ts',
      'apps/runtime/vitest.integration.config.ts',
      'apps/runtime/vitest.sdk-auth.config.ts',
      'apps/runtime/vitest.smoke.config.ts',
      'apps/runtime/src/__tests__/TEST_INDEX.md',
    ],
    rules: [
      {
        kind: 'root-file',
        prefixes: ['constraint-', 'extraction-', 'field-', 'filler-', 'gather-'],
        to: 'extraction',
      },
      {
        kind: 'root-file',
        prefixes: ['delegate-', 'fan-out-', 'multi-intent-', 'prompt-', 'routing-'],
        to: 'routing',
      },
      {
        kind: 'root-file',
        prefixes: ['chat-', 'repos-', 'session-', 'stores'],
        to: 'sessions',
      },
      { from: 'migrations', kind: 'directory', to: 'sessions/migrations' },
      {
        from: 'routes/contacts-history.test.ts',
        kind: 'file',
        to: 'sessions/routes/contacts-history.test.ts',
      },
      {
        from: 'routes/sessions-messages-cursor.test.ts',
        kind: 'file',
        to: 'sessions/routes/sessions-messages-cursor.test.ts',
      },
      {
        kind: 'root-file',
        prefixes: ['attachment-', 'deployment-', 'module-', 'tool-'],
        to: 'tools-deployment',
      },
      {
        from: 'routes/variable-namespace-members-route.test.ts',
        kind: 'file',
        to: 'tools-deployment/routes/variable-namespace-members-route.test.ts',
      },
      {
        from: 'routes/variable-namespaces-route.test.ts',
        kind: 'file',
        to: 'tools-deployment/routes/variable-namespaces-route.test.ts',
      },
      {
        from: 'services/snapshot-service.test.ts',
        kind: 'file',
        to: 'tools-deployment/services/snapshot-service.test.ts',
      },
    ],
    testRoot: RUNTIME_TEST_ROOT,
  },
  'studio-phase4': {
    appRoot: STUDIO_APP_ROOT,
    name: 'studio-phase4',
    referenceFiles: ['apps/studio/vitest.light.config.ts', 'apps/studio/vitest.unit.config.ts'],
    rules: [
      {
        kind: 'root-file',
        prefixes: ['arch-'],
        to: 'arch-ai',
      },
      {
        kind: 'root-file',
        prefixes: ['admin-', 'api-', 'route-'],
        to: 'api-routes',
      },
      { from: 'auth-profiles', kind: 'directory', to: 'api-routes/auth-profiles' },
      {
        exact: ['remaining-stores.test.ts'],
        kind: 'root-file',
        regexes: [/-store(?:-|\.|$)/],
        to: 'stores',
      },
      { from: 'lib', kind: 'directory', to: 'stores/lib' },
      {
        kind: 'root-file',
        regexes: [/-hooks?(?:\.|[-_])/],
        to: 'hooks',
      },
      {
        kind: 'root-file',
        regexes: [/\.test\.tsx$/],
        to: 'components',
      },
    ],
    testRoot: STUDIO_TEST_ROOT,
  },
};

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

export function parseCliArgs(argv: string[]): CliOptions {
  let apply = false;
  let plan: MigrationPlanName | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--plan') {
      const value = argv[index + 1];
      if (!value || !MIGRATION_PLAN_NAMES.includes(value as MigrationPlanName)) {
        throw new Error(`Expected --plan ${MIGRATION_PLAN_NAMES.join('|')}`);
      }
      plan = value as MigrationPlanName;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!plan) {
    throw new Error(`Expected --plan ${MIGRATION_PLAN_NAMES.join('|')}`);
  }

  return { apply, plan };
}

export async function collectMoves(plan: MigrationPlan): Promise<FileMove[]> {
  const topLevelTestFiles = await listTopLevelTestFiles(plan.testRoot);
  const claimedSources = new Set<string>();
  const moves: FileMove[] = [];

  for (const rule of plan.rules) {
    if (rule.kind === 'directory') {
      const sourceDir = join(plan.testRoot, rule.from);
      if (!existsSync(sourceDir)) {
        continue;
      }

      const files = await walkFiles(sourceDir);
      for (const absoluteFile of files) {
        const relativeWithinDir = relative(sourceDir, absoluteFile);
        moves.push(createMove(absoluteFile, join(plan.testRoot, rule.to, relativeWithinDir)));
        claimedSources.add(absoluteFile);
      }
      continue;
    }

    if (rule.kind === 'file') {
      const sourceFile = join(plan.testRoot, rule.from);
      if (!existsSync(sourceFile) || claimedSources.has(sourceFile)) {
        continue;
      }

      moves.push(createMove(sourceFile, join(plan.testRoot, rule.to)));
      claimedSources.add(sourceFile);
      continue;
    }

    for (const absoluteFile of topLevelTestFiles) {
      if (claimedSources.has(absoluteFile)) {
        continue;
      }
      if (!matchesRootRule(absoluteFile, rule)) {
        continue;
      }

      moves.push(
        createMove(absoluteFile, join(plan.testRoot, rule.to, basenameFromPath(absoluteFile))),
      );
      claimedSources.add(absoluteFile);
    }
  }

  validateMovePlan(moves);
  return moves.sort((left, right) => left.fromRelative.localeCompare(right.fromRelative));
}

function createMove(fromAbsolute: string, toAbsolute: string): FileMove {
  return {
    fromAbsolute,
    fromRelative: normalizeSlashes(relative(ROOT, fromAbsolute)),
    toAbsolute,
    toRelative: normalizeSlashes(relative(ROOT, toAbsolute)),
  };
}

async function listTopLevelTestFiles(testRoot: string): Promise<string[]> {
  const entries = await readdir(testRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(test)\.(ts|tsx)$/.test(entry.name))
    .map((entry) => join(testRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function matchesRootRule(absoluteFile: string, rule: RootFileRule): boolean {
  const filename = basenameFromPath(absoluteFile);
  if (rule.exact?.includes(filename)) {
    return true;
  }
  if (rule.prefixes?.some((prefix) => filename.startsWith(prefix))) {
    return true;
  }
  return rule.regexes?.some((pattern) => pattern.test(filename)) ?? false;
}

function basenameFromPath(filePath: string): string {
  const segments = normalizeSlashes(filePath).split('/');
  return segments[segments.length - 1] ?? filePath;
}

function validateMovePlan(moves: FileMove[]): void {
  const sourceSet = new Set<string>();
  const targetSet = new Set<string>();

  for (const move of moves) {
    if (!existsSync(move.fromAbsolute)) {
      throw new Error(`Missing source path: ${move.fromRelative}`);
    }
    if (sourceSet.has(move.fromAbsolute)) {
      throw new Error(`Duplicate source path in move plan: ${move.fromRelative}`);
    }
    if (targetSet.has(move.toAbsolute)) {
      throw new Error(`Duplicate target path in move plan: ${move.toRelative}`);
    }
    if (existsSync(move.toAbsolute)) {
      throw new Error(`Target path already exists: ${move.toRelative}`);
    }

    sourceSet.add(move.fromAbsolute);
    targetSet.add(move.toAbsolute);
  }
}

export function updateRelativeSpecifier(
  specifier: string,
  oldFilePath: string,
  newFilePath: string,
  movedPathLookup: Map<string, string>,
): string {
  if (!specifier.startsWith('.')) {
    return specifier;
  }

  const oldTargetPath = resolve(dirname(oldFilePath), specifier);
  const newTargetPath = movedPathLookup.get(oldTargetPath) ?? oldTargetPath;
  let nextSpecifier = normalizeSlashes(relative(dirname(newFilePath), newTargetPath));

  if (nextSpecifier.length === 0) {
    nextSpecifier = '.';
  } else if (!nextSpecifier.startsWith('.')) {
    nextSpecifier = `./${nextSpecifier}`;
  }

  return nextSpecifier;
}

export function rewriteRelativeSpecifiers(
  sourceText: string,
  oldFilePath: string,
  newFilePath: string,
  movedPathLookup: Map<string, string>,
): string {
  const sourceFile = ts.createSourceFile(
    newFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(newFilePath),
  );

  const replacements: Array<{ end: number; nextValue: string; start: number }> = [];

  const maybeQueueLiteralReplacement = (literal: ts.StringLiteralLike): void => {
    if (!literal.text.startsWith('.')) {
      return;
    }

    const nextValue = updateRelativeSpecifier(
      literal.text,
      oldFilePath,
      newFilePath,
      movedPathLookup,
    );
    if (nextValue === literal.text) {
      return;
    }

    replacements.push({
      end: literal.getEnd() - 1,
      nextValue,
      start: literal.getStart(sourceFile) + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      maybeQueueLiteralReplacement(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      maybeQueueLiteralReplacement(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const literal = node.arguments[0];
      if (
        ts.isStringLiteralLike(literal) &&
        REFERENCE_CALLEES.has(getCallTarget(node.expression, sourceFile))
      ) {
        maybeQueueLiteralReplacement(literal);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (replacements.length === 0) {
    return sourceText;
  }

  let rewritten = sourceText;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    rewritten =
      rewritten.slice(0, replacement.start) +
      replacement.nextValue +
      rewritten.slice(replacement.end);
  }

  return rewritten;
}

function getCallTarget(expression: ts.LeftHandSideExpression, sourceFile: ts.SourceFile): string {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) {
    return 'import';
  }
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    (ts.isIdentifier(expression.expression) || ts.isPropertyAccessExpression(expression.expression))
  ) {
    return expression.getText(sourceFile);
  }
  return expression.getText(sourceFile);
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const extension = extname(filePath);
  switch (extension) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    default:
      return ts.ScriptKind.JS;
  }
}

function buildMovedPathLookup(moves: FileMove[]): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const move of moves) {
    addLookupEntry(lookup, move.fromAbsolute, move.toAbsolute);
  }

  return lookup;
}

function addLookupEntry(
  lookup: Map<string, string>,
  fromAbsolute: string,
  toAbsolute: string,
): void {
  lookup.set(fromAbsolute, toAbsolute);

  const withoutExtension = stripCodeExtension(fromAbsolute);
  if (withoutExtension !== fromAbsolute) {
    lookup.set(withoutExtension, stripCodeExtension(toAbsolute));
  }

  const jsAlias = toJsLikeSpecifierPath(fromAbsolute);
  if (jsAlias) {
    lookup.set(jsAlias, toJsLikeSpecifierPath(toAbsolute) ?? toAbsolute);
  }
}

function stripCodeExtension(filePath: string): string {
  const extension = extname(filePath);
  if (!CODE_EXTENSIONS.has(extension)) {
    return filePath;
  }
  return filePath.slice(0, -extension.length);
}

function toJsLikeSpecifierPath(filePath: string): string | null {
  const extension = extname(filePath);
  if (extension === '.ts' || extension === '.tsx') {
    return `${filePath.slice(0, -extension.length)}.js`;
  }
  if (extension === '.mts') {
    return `${filePath.slice(0, -extension.length)}.mjs`;
  }
  if (extension === '.cts') {
    return `${filePath.slice(0, -extension.length)}.cjs`;
  }
  return null;
}

async function applyMoves(plan: MigrationPlan, moves: FileMove[]): Promise<void> {
  const lookup = buildMovedPathLookup(moves);

  for (const move of moves) {
    await mkdir(dirname(move.toAbsolute), { recursive: true });
    await rename(move.fromAbsolute, move.toAbsolute);

    if (isCodeFile(move.toAbsolute)) {
      const contents = await readFile(move.toAbsolute, 'utf8');
      const rewritten = rewriteRelativeSpecifiers(
        contents,
        move.fromAbsolute,
        move.toAbsolute,
        lookup,
      );
      if (rewritten !== contents) {
        await writeFile(move.toAbsolute, rewritten, 'utf8');
      }
    }

    await removeEmptyParents(dirname(move.fromAbsolute), plan.testRoot);
  }

  await updateReferenceFiles(plan, moves);
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(extname(filePath));
}

async function removeEmptyParents(startDir: string, stopDir: string): Promise<void> {
  let current = startDir;

  while (normalizeSlashes(current).startsWith(`${normalizeSlashes(stopDir)}/`)) {
    try {
      const entries = await readdir(current);
      if (entries.length > 0) {
        return;
      }
      await rmdir(current);
    } catch {
      return;
    }

    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function updateReferenceFiles(plan: MigrationPlan, moves: FileMove[]): Promise<void> {
  const replacements = moves.map((move) => ({
    from: normalizeSlashes(relative(plan.appRoot, move.fromAbsolute)),
    to: normalizeSlashes(relative(plan.appRoot, move.toAbsolute)),
  }));

  for (const referenceFile of plan.referenceFiles) {
    const absoluteFile = join(ROOT, referenceFile);
    if (!existsSync(absoluteFile)) {
      continue;
    }

    const original = await readFile(absoluteFile, 'utf8');
    let updated = original;
    for (const replacement of replacements) {
      updated = updated.split(replacement.from).join(replacement.to);
    }

    if (updated !== original) {
      await writeFile(absoluteFile, updated, 'utf8');
    }
  }
}

function summarizeMoves(plan: MigrationPlan, moves: FileMove[]): string {
  const byDomain = new Map<string, number>();
  for (const move of moves) {
    const relativeTarget = normalizeSlashes(relative(plan.testRoot, move.toAbsolute));
    const domain = relativeTarget.split('/')[0] ?? relativeTarget;
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
  }

  const domainLines = Array.from(byDomain.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([domain, count]) => `- ${domain}: ${count} files`);

  return [`Planned moves: ${moves.length}`, ...domainLines].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options = parseCliArgs(argv);
    const plan = PLANS[options.plan];
    const moves = await collectMoves(plan);

    console.log(summarizeMoves(plan, moves));
    if (!options.apply) {
      const preview = moves
        .slice(0, 20)
        .map((move) => `${move.fromRelative} -> ${move.toRelative}`);
      if (preview.length > 0) {
        console.log('\nPreview:');
        for (const line of preview) {
          console.log(line);
        }
      }
      console.log('\nDry run only. Re-run with --apply to execute the migration.');
      return 0;
    }

    await applyMoves(plan, moves);
    console.log('\nMigration applied.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  });
}
