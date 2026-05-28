#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROUTE_FILE_PATTERN =
  /(^apps\/runtime\/src\/routes\/.*\.ts$|^apps\/studio\/src\/app\/api\/.*\/route\.ts$|^packages\/[^/]+\/src\/.*(?:route|routes|handler|handlers|controller|controllers).*\.ts$)/;
const TEST_FILE_PATTERN = /(__tests__|\.test\.|\.spec\.)/;
const DEBUG_ROUTE_PATTERN = /(^|\/)(debug|traces)(\/|$)/;
const RESPONSE_CALL_PATTERN = /\b(?:res\.(?:json|send)|NextResponse\.json)\s*\(/g;
const SENSITIVE_FIELD_PATTERN = /\b(traceEvents|traceContext)\b/;
const SENSITIVE_FIELD_MATCH_PATTERN = /\b(traceEvents|traceContext)\b/g;
const DEBUG_GATE_PATTERN =
  /\b(buildInlineDebugPayload|includeDebug|debugRequested|isDebug(?:Mode|Enabled)?|withDebugPayload)\b/;
const SANITIZED_TRACE_PATTERN =
  /\b(scrubTraceEventsForResponse|renderRuntimeTraceEventsForReadSurface)\b/;
const ALLOW_PATTERN = /public-response-leak:\s*allow|ALLOW_PUBLIC_RESPONSE_LEAK/;

function usage() {
  console.error(`Usage:
  node tools/public-response-leak-check.mjs --staged
  node tools/public-response-leak-check.mjs --all
  node tools/public-response-leak-check.mjs --files <file...>
  node tools/public-response-leak-check.mjs --path <file> --stdin`);
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

function readStdin() {
  return readFileSync(0, 'utf8');
}

function readStagedFile(filePath) {
  return git(['show', `:${filePath}`]);
}

function isGuardedFile(filePath) {
  const normalized = normalizePath(filePath);
  if (!ROUTE_FILE_PATTERN.test(normalized)) {
    return false;
  }
  if (TEST_FILE_PATTERN.test(normalized)) {
    return false;
  }
  if (DEBUG_ROUTE_PATTERN.test(normalized)) {
    return false;
  }
  return true;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function findMatchingParen(content, openParenIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = openParenIndex; index < content.length; index += 1) {
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

    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function hasLocalAllowComment(content, startIndex) {
  const line = lineNumberAt(content, startIndex);
  const lines = content.split(/\r?\n/);
  const window = lines.slice(Math.max(0, line - 4), Math.min(lines.length, line + 4)).join('\n');
  return ALLOW_PATTERN.test(window);
}

function checkFile({ filePath, content }) {
  const violations = [];

  if (!isGuardedFile(filePath)) {
    return violations;
  }

  for (const match of content.matchAll(RESPONSE_CALL_PATTERN)) {
    const openParenIndex = content.indexOf('(', match.index);
    const closeParenIndex = findMatchingParen(content, openParenIndex);
    if (closeParenIndex === -1) {
      continue;
    }

    const call = content.slice(match.index, closeParenIndex + 1);
    if (!SENSITIVE_FIELD_PATTERN.test(call)) {
      continue;
    }

    if (
      DEBUG_GATE_PATTERN.test(call) ||
      SANITIZED_TRACE_PATTERN.test(call) ||
      hasLocalAllowComment(content, match.index)
    ) {
      continue;
    }

    violations.push({
      line: lineNumberAt(content, match.index),
      fields: [...new Set(call.match(SENSITIVE_FIELD_MATCH_PATTERN) ?? [])],
    });
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
  console.error('PUBLIC RESPONSE LEAK CHECK failed.');
  console.error('');
  console.error(
    'Route responses must not expose raw trace/debug internals by default. Gate them behind an explicit debug helper or add a local `// public-response-leak: allow <reason>` comment.',
  );
  console.error('');

  for (const failure of failures) {
    console.error(`- ${failure.filePath}`);
    for (const violation of failure.violations) {
      console.error(
        `  - line ${violation.line}: raw ${violation.fields.join(', ')} in JSON response`,
      );
    }
  }

  process.exit(1);
}

main();
