#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checkerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'mock-export-drift-check.mjs',
);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function writeFixtureFile(root, filePath, content) {
  const absolutePath = path.join(root, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function initFixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mock-export-drift-'));
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['config', 'user.email', 'codex@example.invalid'], { cwd: root });
  run('git', ['config', 'user.name', 'Codex'], { cwd: root });

  for (const [filePath, content] of Object.entries(files)) {
    writeFixtureFile(root, filePath, content);
  }

  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'baseline'], { cwd: root });
  return root;
}

function runChecker(root) {
  try {
    const stdout = run('node', [checkerPath, '--base', 'HEAD', '--json'], { cwd: root });
    return { status: 0, output: stdout };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testAddedValueExportFails() {
  const root = initFixture({
    'packages/demo/src/widget.ts': `export const existing = 1;\n`,
    'packages/demo/src/__tests__/widget.test.ts': `import { vi } from 'vitest';\n\nvi.mock('../widget.js', () => ({ existing: 1 }));\n`,
  });

  try {
    writeFixtureFile(
      root,
      'packages/demo/src/widget.ts',
      `export const existing = 1;\nexport const added = 2;\n`,
    );
    const result = runChecker(root);
    assert(result.status === 1, 'added value export should fail stale mock check');
    assert(result.output.includes('"missingName": "added"'), 'failure should name missing export');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testTypeOnlyExportPasses() {
  const root = initFixture({
    'packages/demo/src/widget.ts': `export const existing = 1;\n`,
    'packages/demo/src/__tests__/widget.test.ts': `import { vi } from 'vitest';\n\nvi.mock('../widget.js', () => ({ existing: 1 }));\n`,
  });

  try {
    writeFixtureFile(
      root,
      'packages/demo/src/widget.ts',
      `export const existing = 1;\nexport interface AddedOnly {\n  value: string;\n}\n`,
    );
    const result = runChecker(root);
    assert(result.status === 0, 'type-only export should pass stale mock check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testImportOriginalPasses() {
  const root = initFixture({
    'packages/demo/src/widget.ts': `export const existing = 1;\n`,
    'packages/demo/src/__tests__/widget.test.ts': `import { vi } from 'vitest';\n\nvi.mock('../widget.js', async (importOriginal) => ({\n  ...(await importOriginal()),\n  existing: 1,\n}));\n`,
  });

  try {
    writeFixtureFile(
      root,
      'packages/demo/src/widget.ts',
      `export const existing = 1;\nexport const added = 2;\n`,
    );
    const result = runChecker(root);
    assert(result.status === 0, 'importOriginal partial mock should pass stale mock check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testAddedNamedImportFails() {
  const root = initFixture({
    'packages/demo/src/dep.ts': `export const used = 1;\nexport const newThing = 2;\n`,
    'packages/demo/src/consumer.ts': `import { used } from './dep.js';\n\nexport const consumer = used;\n`,
    'packages/demo/src/__tests__/consumer.test.ts': `import { vi } from 'vitest';\n\nvi.mock('../dep.js', () => ({ used: 1 }));\n`,
  });

  try {
    writeFixtureFile(
      root,
      'packages/demo/src/consumer.ts',
      `import { newThing, used } from './dep.js';\n\nexport const consumer = used + newThing;\n`,
    );
    const result = runChecker(root);
    assert(result.status === 1, 'added named import should fail stale mock check');
    assert(
      result.output.includes('"missingName": "newThing"'),
      'failure should name missing import',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const tests = [
  testAddedValueExportFails,
  testTypeOnlyExportPasses,
  testImportOriginalPasses,
  testAddedNamedImportFails,
];

for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}

console.log('mock-export-drift self-test passed');
