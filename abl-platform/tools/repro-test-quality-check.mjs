#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPRO_FILE_PATTERN = /\.repro\.(test|spec)\.(ts|tsx)$/;
const MARKER_PATTERN = /^\s*\/\/\s*(FAILS:\s*reproduces|REGRESSION:)\s+[A-Z][A-Z0-9]+-\d+\b/im;
const INTERNAL_MOCK_PATTERN = /\b(?:vi|jest)\.mock\(\s*["'](?:@abl\/|@agent-platform\/)/;
const SKIP_OR_TODO_PATTERN = /\b(?:describe|it|test)\s*\.\s*(?:skip|todo)\s*\(/;
const ASSERTION_PATTERN = /\b(?:expect\s*\(|assert\s*\.|expect\.hasAssertions\s*\()/;
const TS_EXPECT_ERROR_PATTERN = /@ts-expect-error/;
const EARLY_RETURN_ALLOW_PATTERN = /repro-quality:\s*allow\s+early-return|ALLOW_REPRO_EARLY_RETURN/;
const TS_EXPECT_ERROR_ALLOW_PATTERN =
  /repro-quality:\s*allow\s+ts-expect-error|ALLOW_REPRO_TS_EXPECT_ERROR/;
const NO_MARKER_ALLOW_PATTERN = /repro-quality:\s*allow\s+missing-marker|ALLOW_REPRO_NO_MARKER/;
const SKIP_ALLOW_PATTERN = /repro-quality:\s*allow\s+skip|ALLOW_REPRO_SKIP/;

function usage() {
  console.error(`Usage:
  node tools/repro-test-quality-check.mjs --staged
  node tools/repro-test-quality-check.mjs --all
  node tools/repro-test-quality-check.mjs --files <file...>
  node tools/repro-test-quality-check.mjs --path <file> --stdin`);
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

function isReproFile(filePath) {
  return REPRO_FILE_PATTERN.test(filePath);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function stagedFiles() {
  const raw = git([
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACM',
    '--',
    '*.repro.test.ts',
    '*.repro.test.tsx',
    '*.repro.spec.ts',
    '*.repro.spec.tsx',
  ]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function allReproFiles() {
  const raw = git([
    'ls-files',
    '--',
    '*.repro.test.ts',
    '*.repro.test.tsx',
    '*.repro.spec.ts',
    '*.repro.spec.tsx',
  ]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readStagedFile(filePath) {
  return git(['show', `:${filePath}`]);
}

function resolveImport(fromFile, specifier, root) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return true;
  }

  const baseDir = path.dirname(path.resolve(root, fromFile));
  const base = specifier.startsWith('/')
    ? path.resolve(root, `.${specifier}`)
    : path.resolve(baseDir, specifier);
  const parsed = path.parse(base);
  const tsSourceForJsSpecifier =
    ['.js', '.jsx', '.mjs', '.cjs'].includes(parsed.ext) && path.join(parsed.dir, parsed.name);

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.mts'),
    path.join(base, 'index.cts'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ];

  if (tsSourceForJsSpecifier) {
    candidates.push(
      `${tsSourceForJsSpecifier}.ts`,
      `${tsSourceForJsSpecifier}.tsx`,
      `${tsSourceForJsSpecifier}.mts`,
      `${tsSourceForJsSpecifier}.cts`,
    );
  }

  return candidates.some((candidate) => existsSync(candidate));
}

function findMissingRelativeImports(filePath, content, root) {
  const missing = [];
  const importPatterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of importPatterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        continue;
      }
      if (!resolveImport(filePath, specifier, root)) {
        missing.push(specifier);
      }
    }
  }

  return [...new Set(missing)];
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function findMatchingBrace(content, openBraceIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findTestBodies(content) {
  const ranges = [];
  const testStartPattern = /\b(?:it|test)\s*\(/g;

  for (const match of content.matchAll(testStartPattern)) {
    const arrowIndex = content.indexOf('=>', match.index);
    if (arrowIndex === -1) {
      continue;
    }

    const afterMatchIndex = match.index + match[0].length;
    const nextTestOffset = content.slice(afterMatchIndex).search(/\b(?:it|test)\s*\(/);
    const nextTestIndex = nextTestOffset === -1 ? -1 : afterMatchIndex + nextTestOffset;
    if (nextTestIndex !== -1 && nextTestIndex < arrowIndex) {
      continue;
    }

    const bodyStart = content.indexOf('{', arrowIndex);
    if (bodyStart === -1) {
      continue;
    }

    const bodyEnd = findMatchingBrace(content, bodyStart);
    if (bodyEnd === -1) {
      continue;
    }

    ranges.push({ start: bodyStart + 1, end: bodyEnd });
  }

  return ranges;
}

function findEarlyReturns(content) {
  if (EARLY_RETURN_ALLOW_PATTERN.test(content)) {
    return [];
  }

  const violations = [];

  for (const range of findTestBodies(content)) {
    const body = content.slice(range.start, range.end);
    const assertionMatch = body.match(ASSERTION_PATTERN);
    const searchBody = assertionMatch ? body.slice(0, assertionMatch.index) : body;
    const lineOffset = lineNumberAt(content, range.start) - 1;
    const lines = searchBody.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (
        /^return\s*;/.test(trimmed) ||
        /^if\s*\(.+\)\s*return(?:\s*;|\s+.+;)/.test(trimmed) ||
        /^catch\s*(?:\([^)]*\))?\s*\{\s*return\s*;?\s*\}/.test(trimmed)
      ) {
        violations.push(lineOffset + index + 1);
        continue;
      }

      if (/^if\s*\(.+\)\s*\{/.test(trimmed)) {
        const lookahead = lines
          .slice(index + 1, Math.min(index + 5, lines.length))
          .map((candidate) => candidate.trim())
          .filter(Boolean);
        if (lookahead.some((candidate) => /^return\s*;/.test(candidate))) {
          violations.push(lineOffset + index + 1);
        }
      }
    }
  }

  return violations;
}

function checkFile({ filePath, content, root }) {
  const violations = [];

  if (!isReproFile(filePath)) {
    return violations;
  }

  if (!MARKER_PATTERN.test(content) && !NO_MARKER_ALLOW_PATTERN.test(content)) {
    violations.push(
      'missing ticket marker: add `// FAILS: reproduces ABLP-123` while the bug is open, or `// REGRESSION: ABLP-123` after the fix lands',
    );
  }

  if (SKIP_OR_TODO_PATTERN.test(content) && !SKIP_ALLOW_PATTERN.test(content)) {
    violations.push(
      'contains skipped/todo repro test; repros must execute unless allowlisted with a reason',
    );
  }

  if (INTERNAL_MOCK_PATTERN.test(content)) {
    violations.push(
      'mocks an internal package; repros must exercise real @abl/* and @agent-platform/* code',
    );
  }

  if (TS_EXPECT_ERROR_PATTERN.test(content) && !TS_EXPECT_ERROR_ALLOW_PATTERN.test(content)) {
    violations.push(
      'uses @ts-expect-error; repros should not suppress the contract failure unless explicitly allowlisted',
    );
  }

  if (!ASSERTION_PATTERN.test(content)) {
    violations.push('contains no assertion; repros must prove expected behavior');
  }

  const earlyReturns = findEarlyReturns(content);
  if (earlyReturns.length > 0) {
    violations.push(
      `has early return before the first assertion at line(s) ${earlyReturns.join(
        ', ',
      )}; fail loudly instead of silently passing setup failures`,
    );
  }

  const missingImports = findMissingRelativeImports(filePath, content, root);
  if (missingImports.length > 0) {
    violations.push(
      `imports missing relative module(s): ${missingImports
        .map((specifier) => `\`${specifier}\``)
        .join(', ')}`,
    );
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
      content: readStdin(),
    });
  } else if (mode.staged) {
    for (const filePath of stagedFiles()) {
      inputs.push({ filePath, content: readStagedFile(filePath) });
    }
  } else if (mode.all) {
    for (const filePath of allReproFiles()) {
      inputs.push({
        filePath,
        content: readFileSync(path.resolve(root, filePath), 'utf8'),
      });
    }
  } else if (mode.files.length > 0) {
    for (const rawPath of mode.files) {
      const absolutePath = path.resolve(root, rawPath);
      const filePath = normalizePath(path.relative(root, absolutePath));
      inputs.push({
        filePath,
        content: readFileSync(absolutePath, 'utf8'),
      });
    }
  } else {
    usage();
    process.exit(2);
  }

  const failures = [];
  for (const input of inputs) {
    const violations = checkFile({ ...input, root });
    if (violations.length > 0) {
      failures.push({ filePath: input.filePath, violations });
    }
  }

  if (failures.length === 0) {
    process.exit(0);
  }

  console.error('');
  console.error('REPRO TEST QUALITY CHECK failed.');
  console.error('');
  console.error(
    'Repro tests are executable bug contracts. They must fail for the intended product gap today and become regression coverage after the fix lands.',
  );
  console.error('');

  for (const failure of failures) {
    console.error(`- ${failure.filePath}`);
    for (const violation of failure.violations) {
      console.error(`  - ${violation}`);
    }
  }

  console.error('');
  console.error(
    'Allowed escape hatches must be local and explicit, for example `// repro-quality: allow skip` with a reason.',
  );
  process.exit(1);
}

main();
