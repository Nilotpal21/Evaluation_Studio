import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distRoot = resolve(root, 'dist');
const embedBundlePath = resolve(root, 'dist/agent-sdk.umd.js');

function findJavaScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...findJavaScriptFiles(path));
      continue;
    }
    if (path.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}

function describePath(path) {
  return relative(root, path);
}

const embedOnlyBlockers = [
  {
    pattern: /require\((["'])react\1\)/,
    message:
      'SDK embed bundle still requires React from the host page. The script-tag widget bundle must be self-contained.',
  },
  {
    pattern: /define\(\[(["'])exports\1,\s*(["'])react\2\]/,
    message:
      'SDK embed bundle still advertises React as an AMD dependency. The script-tag widget bundle must be self-contained.',
  },
  {
    pattern: /AgentSDK=\{\},\s*[A-Za-z_$][\w$]*\.React\)/,
    message:
      'SDK embed bundle still expects a global React object from the host page. The script-tag widget bundle must be self-contained.',
  },
  {
    pattern: /process\.env\.NODE_ENV/,
    message:
      'SDK embed bundle still references process.env.NODE_ENV. The script-tag widget bundle must not depend on Node globals.',
  },
];

const browserCspBlockers = [
  {
    pattern: /\b(?:new\s+)?Function\s*\(/,
    message:
      'Browser SDK artifact still uses the Function constructor. This violates strict CSP script-src policies.',
  },
  {
    pattern: /\beval\s*\(/,
    message:
      'Browser SDK artifact still uses eval(). This violates strict CSP script-src policies.',
  },
  {
    pattern: /\bsetTimeout\s*\(\s*(["'])/,
    message:
      'Browser SDK artifact still passes a string to setTimeout(). This violates strict CSP script-src policies.',
  },
  {
    pattern: /\bsetInterval\s*\(\s*(["'])/,
    message:
      'Browser SDK artifact still passes a string to setInterval(). This violates strict CSP script-src policies.',
  },
];

const failures = [];
const embedSource = readFileSync(embedBundlePath, 'utf8');

for (const blocker of embedOnlyBlockers) {
  if (blocker.pattern.test(embedSource)) {
    failures.push(`${describePath(embedBundlePath)}: ${blocker.message}`);
  }
}

for (const artifactPath of findJavaScriptFiles(distRoot)) {
  const source = readFileSync(artifactPath, 'utf8');
  for (const blocker of browserCspBlockers) {
    if (blocker.pattern.test(source)) {
      failures.push(`${describePath(artifactPath)}: ${blocker.message}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log('Validated SDK browser artifacts: self-contained embed and CSP-safe bundles');
