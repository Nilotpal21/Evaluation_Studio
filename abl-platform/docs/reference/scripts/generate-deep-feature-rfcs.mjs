#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const map = JSON.parse(readFileSync('docs/specs/feature-map.json', 'utf8'));
const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  .sort();

const focus = {
  F001: 'Studio project control plane and UX orchestration',
  F002: 'Runtime execution core, channel orchestration, and API ingress',
  F003: 'Threaded session continuity, message memory, and contact context',
  F004: 'ABL language semantics, compiler pipeline, and diagnostics',
  F005: 'Tool authoring, MCP server management, and runtime tool contracts',
  F006: 'Connector lifecycle, auth, callback, and sync orchestration',
  F007: 'Search AI ingestion and KB build pipelines',
  F008: 'Knowledgebase invocation and query-time retrieval runtime',
  F009: 'Guardrails, PII controls, and policy enforcement',
  F010: 'Evals, quality scoring, and scenario/persona testing',
  F011: 'Workflow action execution and orchestration engine',
  F012: 'Human-in-the-loop workflows, approvals, triggers, and notifications',
  F013: 'Project import/export, packaging, and git synchronization',
  F014: 'Agent transfer and A2A execution patterns',
  F015: 'Agent-level observability, traces, and debugging',
  F016: 'System observability, reliability, and analytics operations',
  F017: 'Developer tooling: MCP, CLI, LSP, VSCode, OpenAPI, SDKs',
  F018: 'AI architect-driven agent generation and design automation',
  F019: 'Admin governance, tenant control, and security operations',
  F020: 'Shared persistence and data model backbone',
  F021: 'Sandboxed code execution for tool workloads',
  F022: 'Platform foundations: config, i18n, sizing, style baselines',
  F023: 'Infrastructure delivery automation, CI, scripts, and benchmarks',
  F024: 'Crawler intelligence and browser automation',
};

const scenarioSeeds = {
  F001: [
    'Project bootstrap and navigation',
    'Agent editing session',
    'Cross-feature control-plane fallback',
  ],
  F002: [
    'Request ingress to response',
    'Runtime configuration application',
    'Channel adapter execution',
  ],
  F003: [
    'Session resume after interruption',
    'Attachment-linked conversation turn',
    'Memory API read/write lifecycle',
  ],
  F004: [
    'DSL parse/analyze/compile pipeline',
    'Compiler construct lowering',
    'IDE diagnostics feedback loop',
  ],
  F005: [
    'Tool definition to runtime execution',
    'MCP tool discovery and test',
    'Tool secret resolution path',
  ],
  F006: [
    'Connector setup and authentication',
    'Connector sync trigger flow',
    'Workflow connection test path',
  ],
  F007: [
    'Source ingest to indexed document',
    'Structured data ingest finalize',
    'Knowledge graph enrichment',
  ],
  F008: [
    'Authenticated query invocation',
    'Permission-aware retrieval',
    'IDP sync and cache invalidation',
  ],
  F009: [
    'Policy update to runtime enforcement',
    'PII-sensitive content handling',
    'Safety telemetry and remediation',
  ],
  F010: [
    'Eval preflight to run start',
    'Scenario/persona simulation',
    'Result compare and heatmap review',
  ],
  F011: [
    'Workflow execute and step dispatch',
    'Async callback continuation',
    'Execution cancellation path',
  ],
  F012: [
    'Trigger fire to human approval',
    'Human task assignment and resolve',
    'Notification-driven intervention',
  ],
  F013: [
    'Import preview to apply',
    'Export generation and async delivery',
    'Git promote/pull/push sequence',
  ],
  F014: ['Transfer webhook ingestion', 'Agent handoff execution', 'A2A context propagation'],
  F015: ['Trace capture and retrieval', 'Agent debugging with spans', 'Archive retrieval workflow'],
  F016: [
    'Analytics computation and query',
    'Alert rule evaluation',
    'Reliability incident recovery flow',
  ],
  F017: ['CLI project operation flow', 'MCP debug tool session', 'LSP/IDE assist cycle'],
  F018: [
    'Architect generation loop',
    'Design refinement conversation',
    'Spec scaffolding and apply',
  ],
  F019: [
    'Tenant policy governance update',
    'KMS/model governance path',
    'Usage/billing admin review',
  ],
  F020: [
    'Model registration and access',
    'Cross-service schema consumption',
    'Migration/seed lifecycle',
  ],
  F021: [
    'Sandbox execution request flow',
    'Isolation policy application',
    'Structured runtime logging',
  ],
  F022: [
    'Config schema validation at startup',
    'Sizing recommendation generation',
    'Shared locale/style distribution',
  ],
  F023: [
    'Environment bootstrap and validation',
    'CI quality gate execution',
    'Benchmark run and capacity analysis',
  ],
  F024: [
    'Crawl strategy decision flow',
    'Browser automation MCP execution',
    'Transparency event emission',
  ],
};

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
  if (isPrefixPattern(pattern)) return filePath.startsWith(pattern);
  if (isWildcardPattern(pattern)) return wildcardToRegex(pattern).test(filePath);
  return filePath === pattern || filePath.startsWith(`${pattern}/`);
}

function toApiPath(filePath) {
  if (!filePath.endsWith('/route.ts')) return null;
  if (filePath.includes('/app/api/')) {
    const idx = filePath.indexOf('/app/api/');
    const rest = filePath.slice(idx + '/app/api'.length).replace(/\/route\.ts$/, '');
    return `/api${rest}`;
  }
  return null;
}

function extractRouterMethods(filePath) {
  if (!filePath.includes('/routes/') || !filePath.endsWith('.ts')) return [];
  let txt = '';
  try {
    txt = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return [...txt.matchAll(/router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g)].map(
    (m) => `${m[1].toUpperCase()} ${m[2]}`,
  );
}

function topGroups(files, depth = 3, limit = 18) {
  const counts = new Map();
  for (const file of files) {
    const parts = file.split('/');
    const key = parts.slice(0, Math.min(depth, parts.length)).join('/');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

for (const feature of map.features) {
  const files = trackedFiles.filter((f) => feature.includes.some((p) => matchesPattern(f, p)));
  const focusText = focus[feature.id] || feature.name;

  const routeFiles = files.filter((f) => f.endsWith('/route.ts') || f.includes('/routes/'));
  const apiPaths = routeFiles.map(toApiPath).filter(Boolean);

  const routeMethodInventory = [];
  for (const f of routeFiles.filter((x) => x.includes('/routes/')).slice(0, 80)) {
    const methods = extractRouterMethods(f).slice(0, 8);
    if (methods.length > 0) routeMethodInventory.push({ file: f, methods });
  }

  const serviceFiles = files.filter((f) => f.includes('/services/'));
  const modelFiles = files.filter((f) => /\/models\/.*\.model\.ts$/.test(f));
  const testFiles = files.filter((f) => f.includes('__tests__') || /\.test\./.test(f));
  const workerFiles = files.filter((f) => /workers|executors|handlers|pipeline/.test(f));
  const uiFiles = files.filter(
    (f) => f.includes('/components/') || /\/app\/.*\/(page|layout|error)\.tsx?$/.test(f),
  );

  const groupL1 = topGroups(files, 1, 8);
  const groupL2 = topGroups(files, 2, 12);
  const groupL3 = topGroups(files, 3, 18);

  const sampleImpl = [
    ...groupL3.slice(0, 6).map(([g]) => g),
    ...routeFiles.slice(0, 6),
    ...serviceFiles.slice(0, 6),
    ...modelFiles.slice(0, 6),
  ].filter(Boolean);

  const scenarios = scenarioSeeds[feature.id] || [
    'Primary execution path',
    'Secondary control path',
    'Failure and recovery path',
  ];

  const lines = [];
  lines.push(`# ${feature.rfc.match(/RFC-\d+/)[0]}: ${feature.name}`);
  lines.push('');
  lines.push('- Status: Draft (5-level deep functional specification)');
  lines.push(`- Feature ID: ${feature.id}`);
  lines.push(`- Focus: ${focusText}`);
  lines.push(`- Covered files in feature map: ${files.length}`);
  lines.push(`- Source mapping: \`docs/specs/feature-map.json\``);
  lines.push('');

  lines.push('## 1. Level 1: Business Capability Definition');
  lines.push('');
  lines.push(`This feature delivers **${focusText}** as a first-class platform capability.`);
  lines.push('');
  lines.push('### 1.1 Capability Boundaries');
  lines.push('');
  lines.push('- In-scope top-level domains:');
  for (const [g, c] of groupL1) lines.push(`  - ${g} (${c} files)`);
  lines.push(
    '- Out-of-scope: functionality owned by adjacent split features unless explicitly mapped in this feature.',
  );
  lines.push('');

  lines.push('## 2. Level 2: Domain and Subdomain Decomposition');
  lines.push('');
  lines.push('| Domain (L2) | File Count | Purpose |');
  lines.push('|---|---:|---|');
  for (const [g, c] of groupL2.slice(0, 12)) {
    lines.push(`| ${g} | ${c} | Operational subdomain contributing to ${feature.name}. |`);
  }
  lines.push('');

  lines.push('## 3. Level 3: Functional Flow Decomposition');
  lines.push('');
  lines.push('### 3.1 Primary Flows');
  lines.push('');
  for (const [i, s] of scenarios.entries()) {
    lines.push(`- Flow ${i + 1}: ${s}`);
  }
  lines.push('');
  lines.push('### 3.2 API and Route Surface');
  lines.push('');
  if (apiPaths.length > 0) {
    lines.push(`- App-route endpoints discovered: ${apiPaths.length}`);
    for (const p of apiPaths.slice(0, 50)) lines.push(`  - ${p}`);
    if (apiPaths.length > 50)
      lines.push(`  - ... +${apiPaths.length - 50} additional app-route endpoints`);
  } else {
    lines.push('- No app-route style endpoints directly matched in this feature scope.');
  }
  lines.push('');
  if (routeMethodInventory.length > 0) {
    lines.push('- Router method inventory (module-level):');
    for (const item of routeMethodInventory.slice(0, 24)) {
      lines.push(`  - ${item.file}`);
      for (const m of item.methods) lines.push(`    - ${m}`);
    }
    if (routeMethodInventory.length > 24) {
      lines.push(
        `  - ... +${routeMethodInventory.length - 24} additional route modules with methods`,
      );
    }
  }
  lines.push('');

  lines.push('## 4. Level 4: Implementation Detail (Code Artifacts)');
  lines.push('');
  lines.push('### 4.1 Module Inventory');
  lines.push('');
  lines.push('| Implementation Slice | Count | Representative Artifacts |');
  lines.push('|---|---:|---|');
  lines.push(
    `| UI Components | ${uiFiles.length} | ${uiFiles.slice(0, 3).join('<br/>') || 'N/A'} |`,
  );
  lines.push(
    `| Services | ${serviceFiles.length} | ${serviceFiles.slice(0, 3).join('<br/>') || 'N/A'} |`,
  );
  lines.push(
    `| Routes / Route Modules | ${routeFiles.length} | ${routeFiles.slice(0, 3).join('<br/>') || 'N/A'} |`,
  );
  lines.push(
    `| Data Models | ${modelFiles.length} | ${modelFiles.slice(0, 3).join('<br/>') || 'N/A'} |`,
  );
  lines.push(
    `| Workers / Executors / Pipeline | ${workerFiles.length} | ${workerFiles.slice(0, 3).join('<br/>') || 'N/A'} |`,
  );
  lines.push(`| Tests | ${testFiles.length} | ${testFiles.slice(0, 3).join('<br/>') || 'N/A'} |`);
  lines.push('');

  lines.push('### 4.2 Detailed Implementation Paths');
  lines.push('');
  for (const p of sampleImpl.slice(0, 30)) lines.push(`- ${p}`);
  lines.push('');

  lines.push('## 5. Level 5: Verification, Controls, and Acceptance Depth');
  lines.push('');
  lines.push('### 5.1 Verification Assets');
  lines.push('');
  if (testFiles.length > 0) {
    lines.push(`- Test artifacts in scope: ${testFiles.length}`);
    for (const t of testFiles.slice(0, 40)) lines.push(`  - ${t}`);
    if (testFiles.length > 40)
      lines.push(`  - ... +${testFiles.length - 40} additional test files`);
  } else {
    lines.push(
      '- No direct test files mapped in this feature scope; rely on integration/adjacent suite validation.',
    );
  }
  lines.push('');

  lines.push('### 5.2 5-Level Scenario Chains (Explicit)');
  lines.push('');
  for (const [i, s] of scenarios.entries()) {
    lines.push(`#### Scenario ${i + 1}: ${s}`);
    lines.push('');
    lines.push(`- Level 1 (Outcome): Deliver ${feature.name} business value.`);
    lines.push(
      `- Level 2 (Domain): Execute within mapped subdomains (${
        groupL2
          .slice(0, 3)
          .map(([g]) => g)
          .join(', ') || 'feature modules'
      }).`,
    );
    lines.push(
      `- Level 3 (Flow): Realize workflow stage \"${s}\" through route/service orchestration.`,
    );
    lines.push(
      `- Level 4 (Implementation): Use artifacts such as ${sampleImpl.slice(i * 2, i * 2 + 3).join(', ') || 'core modules in scope'}.`,
    );
    lines.push(
      `- Level 5 (Verification): Validate with tests and controls from ${testFiles.slice(i * 2, i * 2 + 3).join(', ') || 'feature test suites and acceptance checks'}.`,
    );
    lines.push('');
  }

  lines.push('### 5.3 Acceptance Criteria (Deep)');
  lines.push('');
  lines.push(
    `- AC-001: All mapped code paths for ${feature.id} are represented in this feature's decomposition.`,
  );
  lines.push('- AC-002: Each primary flow has route/module/test traceability.');
  lines.push('- AC-003: Security and boundary assumptions are explicit for this feature.');
  lines.push(
    '- AC-004: Adjacent-feature ownership boundaries are preserved by feature-map mapping rules.',
  );
  lines.push('');

  lines.push('## 6. Security, Compliance, and Risk Controls');
  lines.push('');
  lines.push(
    '- Identity and tenancy boundaries are enforced through mapped auth/middleware routes where present.',
  );
  lines.push(
    '- Sensitive data handling is constrained to mapped secure services/models in this feature boundary.',
  );
  lines.push(
    '- Operational risks are mitigated through mapped tests, validation scripts, and route error handling.',
  );
  lines.push('');

  lines.push('## 7. Traceability');
  lines.push('');
  lines.push('- Feature map: `docs/specs/feature-map.json`');
  lines.push('- Coverage summary: `docs/specs/CODE_COVERAGE_SUMMARY.md`');
  lines.push('- File matrix: `docs/specs/CODE_COVERAGE_MATRIX.csv`');
  lines.push('');

  mkdirSync(dirname(feature.rfc), { recursive: true });
  writeFileSync(feature.rfc, `${lines.join('\n')}\n`, 'utf8');
}

console.log(`Generated deep RFC docs for ${map.features.length} features.`);
