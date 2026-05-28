#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const repoRoot = process.env.REPO_ROOT || path.resolve(__dirname, '..');
const studioSrc = path.join(repoRoot, 'apps', 'studio', 'src');
const localeDir = path.join(repoRoot, 'packages', 'i18n', 'locales', 'en');
const ROOT_LOCALE_FILES = new Set(['studio']);
const TRANSLATION_METHODS = new Set(['rich', 'raw', 'has', 'markup']);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function flattenMessages(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const keys = [];
  for (const [key, child] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      keys.push(...flattenMessages(child, nextPrefix));
    } else {
      keys.push(nextPrefix);
    }
  }

  return keys;
}

function loadAvailableKeys() {
  if (!fs.existsSync(localeDir)) {
    fail(`ERROR: Locale directory not found: ${localeDir}`);
  }

  const files = fs
    .readdirSync(localeDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  const availableKeys = new Set();
  for (const file of files) {
    const stem = path.basename(file, '.json');
    const rootPrefix = ROOT_LOCALE_FILES.has(stem) ? '' : `${stem}.`;
    const json = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
    for (const key of flattenMessages(json)) {
      availableKeys.add(`${rootPrefix}${key}`);
    }
  }

  const availablePrefixes = new Set();
  for (const key of availableKeys) {
    const parts = key.split('.');
    for (let index = 1; index < parts.length; index += 1) {
      availablePrefixes.add(parts.slice(0, index).join('.'));
    }
  }

  return { availableKeys, availablePrefixes };
}

function isStaticKey(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function translationBindingName(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    TRANSLATION_METHODS.has(expression.name.text)
  ) {
    return expression.expression.text;
  }

  return null;
}

function collectUsedKeys() {
  const usedKeys = new Set();
  let dynamicCount = 0;
  let fileCount = 0;

  function walkDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walkDirectory(fullPath);
        continue;
      }

      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
        continue;
      }

      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) {
        continue;
      }

      const sourceText = fs.readFileSync(fullPath, 'utf8');
      const sourceFile = ts.createSourceFile(
        fullPath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      const scopes = [new Map()];
      let fileHasTranslations = false;

      function pushScope() {
        scopes.push(new Map());
      }

      function popScope() {
        scopes.pop();
      }

      function bindScope(name, namespace) {
        scopes[scopes.length - 1].set(name, namespace);
      }

      function lookupScope(name) {
        for (let index = scopes.length - 1; index >= 0; index -= 1) {
          if (scopes[index].has(name)) {
            return scopes[index].get(name);
          }
        }
        return undefined;
      }

      function visit(node) {
        let pushedScope = false;
        if (
          ts.isBlock(node) ||
          ts.isModuleBlock(node) ||
          ts.isCaseBlock(node) ||
          ts.isFunctionLike(node) ||
          ts.isClassLike(node)
        ) {
          pushScope();
          pushedScope = true;
        }

        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isCallExpression(node.initializer)
        ) {
          const callee = ts.isIdentifier(node.initializer.expression)
            ? node.initializer.expression.text
            : null;
          const [firstArg] = node.initializer.arguments;
          if (
            (callee === 'useTranslations' || callee === 'getTranslations') &&
            firstArg &&
            isStaticKey(firstArg)
          ) {
            fileHasTranslations = true;
            bindScope(node.name.text, firstArg.text);
          }
        }

        if (ts.isCallExpression(node)) {
          const bindingName = translationBindingName(node.expression);
          if (bindingName) {
            const namespace = lookupScope(bindingName);
            if (namespace) {
              const [firstArg] = node.arguments;
              if (firstArg && isStaticKey(firstArg)) {
                usedKeys.add(`${namespace}.${firstArg.text}`);
              } else {
                dynamicCount += 1;
              }
            }
          }
        }

        ts.forEachChild(node, visit);

        if (pushedScope) {
          popScope();
        }
      }

      visit(sourceFile);
      if (fileHasTranslations) {
        fileCount += 1;
      }
    }
  }

  walkDirectory(studioSrc);
  return { usedKeys, dynamicCount, fileCount };
}

function main() {
  if (!fs.existsSync(studioSrc)) {
    fail(`ERROR: Studio source directory not found: ${studioSrc}`);
  }

  const { availableKeys, availablePrefixes } = loadAvailableKeys();
  const { usedKeys, dynamicCount, fileCount } = collectUsedKeys();

  const missingKeys = [...usedKeys]
    .filter((key) => !availableKeys.has(key) && !availablePrefixes.has(key))
    .sort();

  process.stdout.write('i18n key verification:\n');
  process.stdout.write(`  Translation keys defined: ${availableKeys.size}\n`);
  process.stdout.write(`  Unique keys referenced in code: ${usedKeys.size}\n`);
  process.stdout.write(`  Dynamic keys (skipped): ${dynamicCount}\n`);
  process.stdout.write(`  Source files with translations: ${fileCount}\n`);

  if (missingKeys.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(
      `MISSING KEYS (${missingKeys.length} key(s) used in code but not found in translation JSON):\n\n`,
    );
    for (const key of missingKeys) {
      process.stdout.write(`  ${key}\n`);
    }
    process.stdout.write('\n');
    process.stdout.write(
      'Fix: Add these keys to packages/i18n/locales/en/*.json in the namespace used by the component.\n',
    );
    process.exit(1);
    return;
  }

  process.stdout.write('  Missing keys: 0\n\n');
  process.stdout.write('All referenced i18n keys exist in translation files.\n');
}

main();
