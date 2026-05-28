#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repoRoot = process.cwd();
const mapPath = resolve(repoRoot, 'docs/specs/feature-map.json');
const matrixPath = resolve(repoRoot, 'docs/specs/CODE_COVERAGE_MATRIX.csv');
const summaryPath = resolve(repoRoot, 'docs/specs/CODE_COVERAGE_SUMMARY.md');
const inventoryPath = resolve(repoRoot, 'docs/specs/FEATURE_INVENTORY.md');

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  .sort();

function isPrefixPattern(pattern) {
  return pattern.endsWith('/');
}

function isWildcardPattern(pattern) {
  return pattern.includes('*') || pattern.includes('?');
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexPattern = `^${escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$$`;
  return new RegExp(regexPattern);
}

function matchesPattern(filePath, pattern) {
  if (isPrefixPattern(pattern)) {
    return filePath.startsWith(pattern);
  }
  if (isWildcardPattern(pattern)) {
    return wildcardToRegex(pattern).test(filePath);
  }
  return filePath === pattern || filePath.startsWith(`${pattern}/`);
}

function isInScope(filePath) {
  if (map.scope.includeFiles.some((pattern) => matchesPattern(filePath, pattern))) {
    return true;
  }
  if (map.scope.includePrefixes.some((prefix) => filePath.startsWith(prefix))) {
    return true;
  }
  return false;
}

const scopedFiles = trackedFiles.filter(isInScope);
const featureStats = new Map();
for (const feature of map.features) {
  featureStats.set(feature.id, {
    ...feature,
    files: [],
  });
}

const mappedRows = [];
const unmapped = [];

for (const filePath of scopedFiles) {
  let matchedFeature = null;
  for (const feature of map.features) {
    if (feature.includes.some((pattern) => matchesPattern(filePath, pattern))) {
      matchedFeature = feature;
      break;
    }
  }

  if (!matchedFeature) {
    unmapped.push(filePath);
    mappedRows.push({
      filePath,
      featureId: 'UNMAPPED',
      featureName: 'UNMAPPED',
      rfc: '',
    });
    continue;
  }

  featureStats.get(matchedFeature.id).files.push(filePath);
  mappedRows.push({
    filePath,
    featureId: matchedFeature.id,
    featureName: matchedFeature.name,
    rfc: matchedFeature.rfc,
  });
}

const csvLines = [
  'file_path,feature_id,feature_name,rfc',
  ...mappedRows.map((row) => {
    const esc = (v) => `"${String(v).replaceAll('"', '""')}"`;
    return [esc(row.filePath), esc(row.featureId), esc(row.featureName), esc(row.rfc)].join(',');
  }),
];

mkdirSync(dirname(matrixPath), { recursive: true });
writeFileSync(matrixPath, `${csvLines.join('\n')}\n`, 'utf8');

const sortedFeatures = [...featureStats.values()].sort((a, b) => b.files.length - a.files.length);
const summaryLines = [];
summaryLines.push('# Code Coverage Summary for RFC Set');
summaryLines.push('');
summaryLines.push(`- Generated from: \`docs/specs/feature-map.json\``);
summaryLines.push(`- Scope date: \`${map.generatedAt}\``);
summaryLines.push(`- Total tracked files in repository: **${trackedFiles.length}**`);
summaryLines.push(`- Total files in RFC coverage scope: **${scopedFiles.length}**`);
summaryLines.push(`- Mapped files: **${scopedFiles.length - unmapped.length}**`);
summaryLines.push(`- Unmapped files: **${unmapped.length}**`);
summaryLines.push('');
summaryLines.push('## Feature Coverage');
summaryLines.push('');
summaryLines.push('| Feature | Files | RFC |');
summaryLines.push('|---|---:|---|');
for (const feature of sortedFeatures) {
  const rfcLink = `[${feature.rfc}](/${feature.rfc})`;
  summaryLines.push(`| ${feature.id} - ${feature.name} | ${feature.files.length} | ${rfcLink} |`);
}
summaryLines.push('');
summaryLines.push('## Coverage Artifacts');
summaryLines.push('');
summaryLines.push(
  `- Matrix: [docs/specs/CODE_COVERAGE_MATRIX.csv](/docs/specs/CODE_COVERAGE_MATRIX.csv)`,
);
summaryLines.push(
  `- Inventory: [docs/specs/FEATURE_INVENTORY.md](/docs/specs/FEATURE_INVENTORY.md)`,
);
summaryLines.push('');

if (unmapped.length > 0) {
  summaryLines.push('## Unmapped Files (Action Required)');
  summaryLines.push('');
  for (const filePath of unmapped) {
    summaryLines.push(`- \`${filePath}\``);
  }
}

writeFileSync(summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');

const inventoryLines = [];
inventoryLines.push('# Feature Inventory and Code Ownership');
inventoryLines.push('');
inventoryLines.push(
  'This inventory defines the RFC feature model and the code areas owned by each feature.',
);
inventoryLines.push('');
for (const feature of map.features) {
  const stat = featureStats.get(feature.id);
  inventoryLines.push(`## ${feature.id} - ${feature.name}`);
  inventoryLines.push('');
  inventoryLines.push(`- RFC: [${feature.rfc}](/${feature.rfc})`);
  inventoryLines.push(`- File count in scope: **${stat.files.length}**`);
  inventoryLines.push('- Included code paths:');
  for (const pattern of feature.includes) {
    inventoryLines.push(`  - \`${pattern}\``);
  }
  inventoryLines.push('- Sample files:');
  const sample = stat.files.slice(0, 10);
  if (sample.length === 0) {
    inventoryLines.push('  - _(none matched)_');
  } else {
    for (const filePath of sample) {
      inventoryLines.push(`  - \`${filePath}\``);
    }
  }
  inventoryLines.push('');
}

writeFileSync(inventoryPath, `${inventoryLines.join('\n')}\n`, 'utf8');

if (unmapped.length > 0) {
  console.error(`Unmapped files in RFC scope: ${unmapped.length}`);
  process.exit(1);
}

console.log(
  `Coverage matrix generated: ${mappedRows.length} scoped files mapped to ${map.features.length} features.`,
);
