#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const GUARDED_PATH_PATTERN =
  /(^packages\/project-io\/src\/module-release\/|^apps\/studio\/src\/app\/api\/projects\/\[id\]\/module\/|^apps\/studio\/src\/components\/modules\/PublishModuleDialog\.tsx$|^apps\/studio\/src\/api\/project-io\.ts$)/;
const TEST_FILE_PATTERN = /(__tests__|\.test\.|\.spec\.)/;
const FLATTEN_PATTERNS = [
  {
    name: 'diagnostics.map(...).join(...)',
    pattern: /\bdiagnostics\s*\.\s*map\s*\([^\n]*\)\s*\.\s*join\s*\(/,
  },
  {
    name: 'buildResult.errors.map(...msg...)',
    pattern: /\bbuildResult\s*\.\s*errors\s*\.\s*map\s*\([^\n]*\bmsg\b[^\n]*\)/,
  },
  {
    name: 'messages.join(...)',
    pattern: /\bmessages\s*\.\s*join\s*\(/,
  },
  {
    name: 'errors.join(...)',
    pattern: /\berrors\s*\.\s*join\s*\(/,
  },
  {
    name: 'sanitizeError(...) on publish path',
    pattern: /\bsanitizeError\s*\(/,
  },
];
const ALLOW_PATTERN = /structured-diagnostics:\s*allow|ALLOW_STRUCTURED_DIAGNOSTICS_FLATTENING/;

function usage() {
  console.error(`Usage:
  node tools/structured-diagnostics-check.mjs --staged
  node tools/structured-diagnostics-check.mjs --all
  node tools/structured-diagnostics-check.mjs --files <file...>
  node tools/structured-diagnostics-check.mjs --path <file> --stdin`);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function repoRoot() {
  try {
    return git(['rev-parse', '--show-toplevel']).trim();
  } catch {
    return process.cwd();
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function isGuardedFile(filePath) {
  const normalized = normalizePath(filePath);
  return GUARDED_PATH_PATTERN.test(normalized) && !TEST_FILE_PATTERN.test(normalized);
}

function stagedFiles() {
  const raw = git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', '*.ts', '*.tsx']);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isGuardedFile);
}

function allFiles() {
  const raw = git(['ls-files', '--', '*.ts', '*.tsx']);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isGuardedFile);
}

function readStagedFile(filePath) {
  return git(['show', `:${filePath}`]);
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function hasLocalAllowComment(content, index) {
  const line = lineNumberAt(content, index);
  const lines = content.split(/\r?\n/);
  const window = lines.slice(Math.max(0, line - 4), Math.min(lines.length, line + 4)).join('\n');
  return ALLOW_PATTERN.test(window);
}

function checkFile({ filePath, content }) {
  const violations = [];

  if (!isGuardedFile(filePath)) {
    return violations;
  }

  for (const rule of FLATTEN_PATTERNS) {
    for (const match of content.matchAll(new RegExp(rule.pattern, 'g'))) {
      if (hasLocalAllowComment(content, match.index ?? 0)) {
        continue;
      }
      violations.push({
        line: lineNumberAt(content, match.index ?? 0),
        pattern: rule.name,
      });
    }
  }

  return violations;
}

function parseArgs(argv) {
  const args = [...argv];
  const mode = {
    all: false,
    staged: false,
    stdin: false,
    path: '',
    files: [],
  };

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--all':
        mode.all = true;
        break;
      case '--staged':
        mode.staged = true;
        break;
      case '--stdin':
        mode.stdin = true;
        break;
      case '--path':
        mode.path = args.shift() || '';
        break;
      case '--files':
        mode.files.push(...args.splice(0));
        break;
      default:
        if (arg?.startsWith('--')) {
          throw new Error(`Unknown argument: ${arg}`);
        }
        mode.files.push(arg);
    }
  }

  return mode;
}

function main() {
  const root = repoRoot();
  let mode;

  try {
    mode = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }

  const inputs = [];

  if (mode.stdin) {
    if (!mode.path) {
      usage();
      process.exit(2);
    }
    inputs.push({
      filePath: normalizePath(path.relative(root, path.resolve(root, mode.path))),
      content: readFileSync(0, 'utf8'),
    });
  } else if (mode.staged) {
    for (const filePath of stagedFiles()) {
      inputs.push({ filePath, content: readStagedFile(filePath) });
    }
  } else if (mode.all) {
    for (const filePath of allFiles()) {
      inputs.push({
        filePath,
        content: readFileSync(path.resolve(root, filePath), 'utf8'),
      });
    }
  } else if (mode.files.length > 0) {
    for (const rawPath of mode.files) {
      const absolutePath = path.resolve(root, rawPath);
      inputs.push({
        filePath: normalizePath(path.relative(root, absolutePath)),
        content: readFileSync(absolutePath, 'utf8'),
      });
    }
  } else {
    usage();
    process.exit(2);
  }

  const failures = [];
  for (const input of inputs) {
    const violations = checkFile(input);
    if (violations.length > 0) {
      failures.push({ filePath: input.filePath, violations });
    }
  }

  if (failures.length === 0) {
    process.exit(0);
  }

  console.error('');
  console.error('STRUCTURED DIAGNOSTICS CHECK failed.');
  console.error('');
  console.error(
    'Module publish diagnostics must stay structured across builder, API, client, and UI layers. Do not flatten diagnostic arrays into one string unless a local `// structured-diagnostics: allow <reason>` comment explains why.',
  );
  console.error('');

  for (const failure of failures) {
    console.error(`- ${failure.filePath}`);
    for (const violation of failure.violations) {
      console.error(`  - line ${violation.line}: ${violation.pattern}`);
    }
  }

  process.exit(1);
}

main();
