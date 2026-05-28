#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
const ALL_MODULE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS];
const SOURCE_FILE_PATTERN = /^(apps|packages)\/[^/]+\/src\/.*\.(ts|tsx|mts|cts)$/;
const TEST_FILE_PATTERN = /(^|\/)__tests__\/|[._-](test|spec)\.(ts|tsx|mts|cts)$/;
const MOCK_ALLOW_PATTERN = /mock-export-drift:\s*allow|ALLOW_MOCK_EXPORT_DRIFT/;

function usage() {
  console.error(`Usage:
  node tools/mock-export-drift-check.mjs [--base <ref>] [--staged] [--all] [--json]

Options:
  --base <ref>  Compare against the provided base ref. Defaults to @{upstream}, then origin/develop.
  --staged      Compare staged changes against HEAD.
  --all         Scan all test files for mocks while keeping findings diff-scoped. This is the default.
  --json        Print machine-readable JSON.`);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function tryGit(args, options = {}) {
  try {
    return git(args, options);
  } catch {
    return '';
  }
}

function repoRoot() {
  const root = tryGit(['rev-parse', '--show-toplevel']).trim();
  return root || process.cwd();
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function toRepoPath(root, filePath) {
  return normalizePath(path.relative(root, filePath));
}

function isTsFile(filePath) {
  return /\.(ts|tsx|mts|cts)$/.test(filePath) && !/\.d\.ts$/.test(filePath);
}

function isSourceFile(filePath) {
  return SOURCE_FILE_PATTERN.test(normalizePath(filePath)) && isTsFile(filePath);
}

function isTestFile(filePath) {
  return TEST_FILE_PATTERN.test(normalizePath(filePath)) && isTsFile(filePath);
}

function parseArgs(argv) {
  const args = [...argv];
  const mode = {
    all: false,
    staged: false,
    json: false,
    base: '',
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
      case '--json':
        mode.json = true;
        break;
      case '--base':
        mode.base = args.shift() || '';
        if (!mode.base) {
          throw new Error('--base requires a ref');
        }
        break;
      case '--help':
      case '-h':
        mode.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return mode;
}

function resolveBaseRef(mode) {
  if (mode.staged) {
    return {
      label: 'HEAD',
      commit: tryGit(['rev-parse', '--verify', 'HEAD']).trim(),
    };
  }

  if (mode.base) {
    const commit = tryGit(['rev-parse', '--verify', mode.base]).trim();
    if (!commit) {
      throw new Error(`Could not resolve base ref: ${mode.base}`);
    }
    return { label: mode.base, commit };
  }

  const upstream = tryGit(['rev-parse', '--verify', '@{upstream}']).trim();
  if (upstream) {
    return { label: '@{upstream}', commit: upstream };
  }

  const develop = tryGit(['rev-parse', '--verify', 'origin/develop']).trim();
  if (develop) {
    return { label: 'origin/develop', commit: develop };
  }

  throw new Error('Could not resolve a base ref from @{upstream} or origin/develop');
}

function resolveComparisonBase(mode, baseRef) {
  if (mode.staged) {
    return baseRef.commit;
  }

  const mergeBase = tryGit(['merge-base', baseRef.commit, 'HEAD']).trim();
  return mergeBase || baseRef.commit;
}

function splitLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function changedFilesForMode(mode, comparisonBase) {
  if (mode.staged) {
    return splitLines(
      tryGit([
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=ACMR',
        '--',
        '*.ts',
        '*.tsx',
        '*.mts',
        '*.cts',
      ]),
    ).filter(isTsFile);
  }

  return unique([
    ...splitLines(
      tryGit([
        'diff',
        '--name-only',
        '--diff-filter=ACMR',
        `${comparisonBase}...HEAD`,
        '--',
        '*.ts',
        '*.tsx',
        '*.mts',
        '*.cts',
      ]),
    ),
    ...splitLines(
      tryGit([
        'diff',
        '--name-only',
        '--diff-filter=ACMR',
        'HEAD',
        '--',
        '*.ts',
        '*.tsx',
        '*.mts',
        '*.cts',
      ]),
    ),
    ...splitLines(
      tryGit([
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        '*.ts',
        '*.tsx',
        '*.mts',
        '*.cts',
      ]),
    ),
  ]).filter(isTsFile);
}

function allTestFiles(mode) {
  const tracked = splitLines(tryGit(['ls-files', '--', '*.ts', '*.tsx', '*.mts', '*.cts']));
  if (mode.staged) {
    return tracked.filter(isTestFile);
  }

  return unique([
    ...tracked,
    ...splitLines(
      tryGit([
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        '*.ts',
        '*.tsx',
        '*.mts',
        '*.cts',
      ]),
    ),
  ]).filter(isTestFile);
}

function readBaseFile(comparisonBase, filePath) {
  return tryGit(['show', `${comparisonBase}:${filePath}`]);
}

function readCurrentFile(root, filePath, mode) {
  if (mode.staged) {
    const staged = tryGit(['show', `:${filePath}`]);
    if (staged) {
      return staged;
    }
  }

  const absolutePath = path.resolve(root, filePath);
  if (existsSync(absolutePath)) {
    return readFileSync(absolutePath, 'utf8');
  }

  return tryGit(['show', `HEAD:${filePath}`]);
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function createSourceFile(filePath, content) {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

function collectBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, names);
      }
    }
  }
}

function collectLocalDeclarationKinds(sourceFile) {
  const values = new Set();
  const types = new Set();

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, values);
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      values.add(statement.name.text);
      continue;
    }

    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      types.add(statement.name.text);
    }
  }

  return { values, types };
}

function addExport(exports, name, sourceFile, node) {
  if (!name || name === 'default') {
    return;
  }

  exports.set(name, {
    name,
    line: lineNumberAt(sourceFile.text, node.getStart(sourceFile)),
  });
}

function collectNamedValueExports(filePath, content) {
  if (!content.trim()) {
    return new Map();
  }

  const sourceFile = createSourceFile(filePath, content);
  const localDeclarations = collectLocalDeclarationKinds(sourceFile);
  const exports = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        const names = new Set();
        collectBindingNames(declaration.name, names);
        for (const name of names) {
          addExport(exports, name, sourceFile, declaration);
        }
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      statement.name
    ) {
      addExport(exports, statement.name.text, sourceFile, statement);
      continue;
    }

    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.exportClause) {
      continue;
    }

    if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) {
          continue;
        }

        const localName = element.propertyName?.text ?? element.name.text;
        const isLocalTypeOnly =
          !statement.moduleSpecifier &&
          localDeclarations.types.has(localName) &&
          !localDeclarations.values.has(localName);
        if (isLocalTypeOnly) {
          continue;
        }

        addExport(exports, element.name.text, sourceFile, element);
      }
      continue;
    }

    if (ts.isNamespaceExport(statement.exportClause)) {
      addExport(exports, statement.exportClause.name.text, sourceFile, statement.exportClause);
    }
  }

  return exports;
}

function collectNamedValueImports(root, filePath, content) {
  if (!content.trim()) {
    return [];
  }

  const sourceFile = createSourceFile(filePath, content);
  const imports = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) {
      continue;
    }

    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    const targetFile = resolveRelativeModule(root, filePath, specifier);
    if (!targetFile) {
      continue;
    }

    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }

      const importedName = element.propertyName?.text ?? element.name.text;
      imports.push({
        importedName,
        modulePath: targetFile,
        line: lineNumberAt(content, element.getStart(sourceFile)),
      });
    }
  }

  return imports;
}

function relativeModuleCandidates(root, fromFile, specifier) {
  const fromDir = path.dirname(path.resolve(root, fromFile));
  const rawTarget = path.resolve(fromDir, specifier);
  const parsed = path.parse(rawTarget);
  const candidates = [];

  if (JS_EXTENSIONS.includes(parsed.ext)) {
    const stem = path.join(parsed.dir, parsed.name);
    for (const extension of TS_EXTENSIONS) {
      candidates.push(`${stem}${extension}`);
    }
  }

  if (ALL_MODULE_EXTENSIONS.includes(parsed.ext)) {
    candidates.push(rawTarget);
  } else {
    for (const extension of ALL_MODULE_EXTENSIONS) {
      candidates.push(`${rawTarget}${extension}`);
    }

    for (const extension of ALL_MODULE_EXTENSIONS) {
      candidates.push(path.join(rawTarget, `index${extension}`));
    }
  }

  return candidates;
}

function resolveRelativeModule(root, fromFile, specifier) {
  for (const candidate of relativeModuleCandidates(root, fromFile, specifier)) {
    if (existsSync(candidate)) {
      return toRepoPath(root, candidate);
    }
  }

  return '';
}

function isMockCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }

  const receiver = node.expression.expression;
  const method = node.expression.name.text;
  return (
    method === 'mock' &&
    ts.isIdentifier(receiver) &&
    (receiver.text === 'vi' || receiver.text === 'jest')
  );
}

function unwrapExpression(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
    current = current.expression;
  }
  return current;
}

function collectObjectExportNames(objectLiteral) {
  const names = new Set();
  let hasSpread = false;

  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      hasSpread = true;
      continue;
    }

    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property) ||
      ts.isGetAccessorDeclaration(property)
    ) {
      const name = property.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        names.add(name.text);
      }
    }
  }

  return { names, hasSpread };
}

function returnObjectLiterals(factory) {
  const objects = [];

  function visit(node) {
    if (ts.isReturnStatement(node) && node.expression) {
      const expression = unwrapExpression(node.expression);
      if (ts.isObjectLiteralExpression(expression)) {
        objects.push(expression);
      }
      return;
    }

    ts.forEachChild(node, visit);
  }

  if (ts.isArrowFunction(factory) && !ts.isBlock(factory.body)) {
    const expression = unwrapExpression(factory.body);
    if (ts.isObjectLiteralExpression(expression)) {
      objects.push(expression);
    }
    return objects;
  }

  visit(factory.body ?? factory);
  return objects;
}

function collectFactoryExportShape(sourceFile, factory) {
  const objects = returnObjectLiterals(factory);
  if (objects.length === 0) {
    return null;
  }

  const names = new Set();
  let hasSpread = false;
  for (const object of objects) {
    const result = collectObjectExportNames(object);
    for (const name of result.names) {
      names.add(name);
    }
    hasSpread = hasSpread || result.hasSpread;
  }

  const text = factory.getText(sourceFile);
  const preservesOriginals =
    hasSpread && /\b(importOriginal|importActual|requireActual)\b/.test(text);

  return { names, preservesOriginals };
}

function hasLocalMockAllowComment(content, index) {
  const line = lineNumberAt(content, index);
  const lines = content.split(/\r?\n/);
  const window = lines.slice(Math.max(0, line - 4), Math.min(lines.length, line + 4)).join('\n');
  return MOCK_ALLOW_PATTERN.test(window);
}

function collectMocks(root, testFile, content) {
  if (!content.trim()) {
    return [];
  }

  const sourceFile = createSourceFile(testFile, content);
  const mocks = [];

  function visit(node) {
    if (isMockCall(node)) {
      const [specifierNode, factory] = node.arguments;
      if (
        specifierNode &&
        ts.isStringLiteralLike(specifierNode) &&
        specifierNode.text.startsWith('.') &&
        factory &&
        (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) &&
        !hasLocalMockAllowComment(content, node.getStart(sourceFile))
      ) {
        const modulePath = resolveRelativeModule(root, testFile, specifierNode.text);
        const shape = modulePath ? collectFactoryExportShape(sourceFile, factory) : null;
        if (modulePath && shape) {
          mocks.push({
            testFile,
            modulePath,
            specifier: specifierNode.text,
            line: lineNumberAt(content, node.getStart(sourceFile)),
            exportedNames: shape.names,
            preservesOriginals: shape.preservesOriginals,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return mocks;
}

function addedValueExportsForFile(filePath, currentContent, baseContent) {
  const currentExports = collectNamedValueExports(filePath, currentContent);
  const baseExports = collectNamedValueExports(filePath, baseContent);
  const added = [];

  for (const [name, exportInfo] of currentExports) {
    if (!baseExports.has(name)) {
      added.push(exportInfo);
    }
  }

  return added;
}

function addedNamedImportsForFile(root, filePath, currentContent, baseContent) {
  const currentImports = collectNamedValueImports(root, filePath, currentContent);
  const baseKeys = new Set(
    collectNamedValueImports(root, filePath, baseContent).map(
      (importInfo) => `${importInfo.modulePath}:${importInfo.importedName}`,
    ),
  );

  return currentImports.filter(
    (importInfo) => !baseKeys.has(`${importInfo.modulePath}:${importInfo.importedName}`),
  );
}

function addExpectation(expectations, modulePath, name, reason) {
  const key = `${modulePath}:${name}:${reason.kind}:${reason.file}:${reason.line}`;
  if (!expectations.has(key)) {
    expectations.set(key, { modulePath, name, reason });
  }
}

function buildExpectations(root, mode, changedFiles, comparisonBase) {
  const expectations = new Map();

  for (const filePath of changedFiles) {
    const currentContent = readCurrentFile(root, filePath, mode);
    if (!currentContent.trim()) {
      continue;
    }

    const baseContent = readBaseFile(comparisonBase, filePath);

    if (isSourceFile(filePath) && !isTestFile(filePath)) {
      for (const exportInfo of addedValueExportsForFile(filePath, currentContent, baseContent)) {
        addExpectation(expectations, filePath, exportInfo.name, {
          kind: 'new value export',
          file: filePath,
          line: exportInfo.line,
        });
      }
    }

    if (isSourceFile(filePath) || isTestFile(filePath)) {
      for (const importInfo of addedNamedImportsForFile(
        root,
        filePath,
        currentContent,
        baseContent,
      )) {
        addExpectation(expectations, importInfo.modulePath, importInfo.importedName, {
          kind: 'new named value import',
          file: filePath,
          line: importInfo.line,
        });
      }
    }
  }

  return [...expectations.values()];
}

function loadMocks(root, mode, testFiles) {
  const mocks = [];

  for (const testFile of testFiles) {
    const content = readCurrentFile(root, testFile, mode);
    if (!content.trim()) {
      continue;
    }

    mocks.push(...collectMocks(root, testFile, content));
  }

  return mocks;
}

function findDrift(expectations, mocks) {
  const mocksByModule = new Map();
  for (const mock of mocks) {
    const existing = mocksByModule.get(mock.modulePath) ?? [];
    existing.push(mock);
    mocksByModule.set(mock.modulePath, existing);
  }

  const findings = [];

  for (const expectation of expectations) {
    for (const mock of mocksByModule.get(expectation.modulePath) ?? []) {
      if (mock.preservesOriginals || mock.exportedNames.has(expectation.name)) {
        continue;
      }

      findings.push({
        testFile: mock.testFile,
        line: mock.line,
        mockedModulePath: mock.modulePath,
        mockedSpecifier: mock.specifier,
        missingName: expectation.name,
        reason: expectation.reason,
      });
    }
  }

  return findings.sort((left, right) => {
    const fileOrder = left.testFile.localeCompare(right.testFile);
    if (fileOrder !== 0) {
      return fileOrder;
    }
    return left.missingName.localeCompare(right.missingName);
  });
}

function printText(result) {
  if (result.findings.length === 0) {
    console.log('Mock export drift check passed.');
    console.log(
      `Compared against ${result.baseRef} (${result.comparisonBase.slice(0, 12)}); no diff-scoped stale internal mocks found.`,
    );
    return;
  }

  console.error('');
  console.error('MOCK EXPORT DRIFT CHECK failed.');
  console.error('');
  console.error(
    'A changed file introduced a runtime value that is imported from, or exported by, an internal module that a test fully mocks. Update the test seam, prefer dependency injection where practical, or use an importOriginal()/importActual() partial mock when the real module exports should pass through.',
  );
  console.error('');

  for (const finding of result.findings) {
    console.error(`- ${finding.testFile}:${finding.line}`);
    console.error(`  mocked module: ${finding.mockedSpecifier} -> ${finding.mockedModulePath}`);
    console.error(`  missing value export/import: ${finding.missingName}`);
    console.error(
      `  reason: ${finding.reason.kind} at ${finding.reason.file}:${finding.reason.line}`,
    );
  }

  console.error('');
}

function main() {
  let mode;
  try {
    mode = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }

  if (mode.help) {
    usage();
    process.exit(0);
  }

  const root = repoRoot();
  process.chdir(root);

  let baseRef;
  let comparisonBase;
  try {
    baseRef = resolveBaseRef(mode);
    comparisonBase = resolveComparisonBase(mode, baseRef);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const changedFiles = changedFilesForMode(mode, comparisonBase);
  const expectations = buildExpectations(root, mode, changedFiles, comparisonBase);
  const mocks = expectations.length > 0 ? loadMocks(root, mode, allTestFiles(mode)) : [];
  const findings = findDrift(expectations, mocks);
  const result = {
    ok: findings.length === 0,
    mode: mode.staged ? 'staged' : 'base',
    baseRef: baseRef.label,
    comparisonBase,
    changedFiles,
    findings,
  };

  if (mode.json) {
    const output = JSON.stringify(result, null, 2);
    if (findings.length > 0) {
      console.error(output);
    } else {
      console.log(output);
    }
  } else {
    printText(result);
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

main();
