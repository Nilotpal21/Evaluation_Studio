# Calibration Pipeline — Plan 5: Report Generation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create Handlebars report templates, PDF styling, and CLI commands (`sizing report`, `sizing load-report`) that generate markdown and PDF reports from calibration profiles and k6 load test results.

**Architecture:** Three report types serve different audiences: internal saturation (full raw data for platform team), customer saturation (polished SLA-focused for customers/SEs), and load test (performance at current replica count). Templates are Handlebars `.hbs` files compiled at runtime with data extracted from `CalibrationProfile` or k6 JSON summaries. PDF generation uses `md-to-pdf` (Puppeteer/headless Chromium) with graceful fallback to markdown-only when Chromium is unavailable.

**Tech Stack:** TypeScript, Handlebars, md-to-pdf, Commander, existing `@agent-platform/sizing-calculator` package

**Spec:** `docs/superpowers/specs/2026-03-24-benchmark-sizing-calibration-design.md` — Sections 11 (CLI commands: `sizing report`, `sizing load-report`), 12 (Report Generation), 14 (New Files)

**Depends on:** Plan 1 (CalibrationProfile types, Zod schema), Plan 4 (CLI benchmark orchestrator, sizing.ts structure)

**Plan series:** This is Plan 5 of 6. Builds on types from Plan 1 and CLI integration from Plan 4.

| Plan         | Subsystem                                      | Status |
| ------------ | ---------------------------------------------- | ------ |
| 1            | Data Model + Traffic Model + Sizing Calculator | Done   |
| 2            | Saturation k6 Scripts + Shared Lib             | —      |
| 3            | Coroot Metrics Collector                       | —      |
| 4            | CLI Benchmark Orchestrator                     | —      |
| **5 (this)** | Report Generation                              | —      |
| 6            | Shell Script Updates (service groups)          | —      |

---

## File Structure

### New Files

| File                                                       | Responsibility                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `benchmarks/report/templates/internal.hbs`                 | Internal saturation report template (full raw data, calibration deltas, warnings)           |
| `benchmarks/report/templates/customer.hbs`                 | Customer-facing saturation report template (SLA compliance, topology recommendation)        |
| `benchmarks/report/templates/load-test.hbs`                | Load test report template (per-service latency, throughput, SLA compliance)                 |
| `benchmarks/report/styles/customer-report.css`             | PDF styling for customer-facing reports (A4 format, branding, tables)                       |
| `packages/kore-platform-cli/src/commands/sizing-report.ts` | `sizing report` and `sizing load-report` CLI commands, Handlebars rendering, PDF generation |

### Modified Files

| File                                                | Changes                                                     |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `packages/kore-platform-cli/src/commands/sizing.ts` | Import and register report commands from `sizing-report.ts` |
| `packages/kore-platform-cli/package.json`           | Add `handlebars` and `md-to-pdf` as dependencies (runtime)  |

---

## Task 1: PDF Styling — Customer Report CSS

**Files:**

- Create: `benchmarks/report/styles/customer-report.css`

> No TDD for CSS — verified visually by generating a sample PDF in Task 6.

- [ ] **Step 1: Create the styles directory and CSS file**

Create `benchmarks/report/styles/customer-report.css` with styling for A4 PDF output:

```css
/* Customer Report Styles — used by md-to-pdf for PDF generation */

body {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  font-size: 11pt;
  line-height: 1.6;
  color: #1a1a2e;
  max-width: 100%;
}

h1 {
  color: #16213e;
  border-bottom: 3px solid #0f3460;
  padding-bottom: 8px;
  font-size: 22pt;
  margin-top: 0;
}

h2 {
  color: #0f3460;
  border-bottom: 1px solid #e0e0e0;
  padding-bottom: 4px;
  font-size: 16pt;
  margin-top: 24pt;
}

h3 {
  color: #533483;
  font-size: 13pt;
  margin-top: 16pt;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin: 12pt 0;
  font-size: 10pt;
}

th {
  background-color: #0f3460;
  color: white;
  padding: 8px 10px;
  text-align: left;
  font-weight: 600;
}

td {
  padding: 6px 10px;
  border-bottom: 1px solid #e0e0e0;
}

tr:nth-child(even) {
  background-color: #f8f9fa;
}

/* Status indicators */
.pass {
  color: #27ae60;
  font-weight: 700;
}

.fail {
  color: #e74c3c;
  font-weight: 700;
}

.warn {
  color: #f39c12;
  font-weight: 700;
}

/* Executive summary box */
blockquote {
  border-left: 4px solid #0f3460;
  background-color: #f0f4f8;
  padding: 12px 16px;
  margin: 12pt 0;
  font-style: normal;
}

code {
  background-color: #f0f0f0;
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 9pt;
}

/* Page break hints for PDF */
h2 {
  page-break-before: auto;
}

.page-break {
  page-break-before: always;
}
```

> **CSS classes in markdown tables:** Standard markdown table cells do not support CSS class attributes. Handlebars templates should use inline HTML for status indicators within table cells, e.g., `<span class="pass">PASS</span>`, `<span class="fail">FAIL</span>`, `<span class="warn">WARN</span>`. The `.pass`, `.fail`, and `.warn` CSS classes above will style these inline spans when rendered as PDF via md-to-pdf. In raw markdown display, the `<span>` tags render as plain text which is acceptable.

- [ ] **Step 2: Commit**

```bash
npx prettier --write benchmarks/report/styles/customer-report.css
git add benchmarks/report/styles/customer-report.css
git commit -m "[ABLP-2] feat(sizing-calculator): add customer report PDF stylesheet"
```

---

## Task 2: Internal Saturation Report Template

**Files:**

- Create: `benchmarks/report/templates/internal.hbs`

> No TDD for templates — verified by generating a sample report in Task 6.

- [ ] **Step 1: Create the internal report template**

Create `benchmarks/report/templates/internal.hbs`. This template receives a `CalibrationProfile` object as its context and renders a full internal engineering report.

Template sections (from design spec Section 12):

1. **Executive Summary** — `{{tier}}`, services tested count, saturation triggers summary, calibration profile path
2. **Per-Service Capacity Table** — iterate `{{#each services}}` rendering: service name, `maxRpsPerPod`, `saturation.trigger`, `measured.cpuPeak`, `measured.memoryPeak`, `latency.baselineP95Ms`, saturated p95, `measured.oomKills`, `testedUrl`, `testedViaIngress`
3. **Per-Service Detail** — `{{#each services}}` with: full k6 metrics, full Coroot metrics, calibration-vs-hardcoded comparison (passed as `hardcodedBaseline` in context), per-scenario breakdown table
4. **WebSocket Capacity** — conditional `{{#if websocket}}` per service: max connections/pod, memory per connection, connect latency, endpoint-level breakdown table
5. **Data Store Capacity Table** — iterate `{{#each dataStores}}`: connections used/max, query p95, write p95, CPU peak, memory peak, disk used, data source
6. **Data Store Detail** — `{{#each dataStores}}` with full metrics and store-specific values
7. **Integration Flow Results** — conditional `{{#if integrationFlows}}`: system ceiling per flow, bottleneck service, per-service metrics during cross-service load
8. **Warnings** — iterate `{{#each warnings}}` array (computed by the CLI before template rendering)

Key Handlebars helpers needed (registered by the CLI):

- `{{formatMs value}}` — format milliseconds with appropriate unit (e.g., `120ms`, `1.2s`)
- `{{formatPercent value}}` — format as percentage (e.g., `24%`)
- `{{statusIcon value threshold}}` — returns pass/fail/warn text based on comparison
- `{{defaultVal value fallback}}` — null-safe default (e.g., `{{defaultVal measured.cpuPeak "N/A"}}`)

The template should produce valid markdown that renders well both as raw `.md` and when converted to PDF.

Estimated size: ~200-250 lines of Handlebars markdown.

- [ ] **Step 2: Commit**

```bash
npx prettier --write benchmarks/report/templates/internal.hbs
git add benchmarks/report/templates/internal.hbs
git commit -m "[ABLP-2] feat(sizing-calculator): add internal saturation report Handlebars template"
```

---

## Task 3: Customer Saturation Report Template

**Files:**

- Create: `benchmarks/report/templates/customer.hbs`

- [ ] **Step 1: Create the customer report template**

Create `benchmarks/report/templates/customer.hbs`. This template receives a context object containing the `CalibrationProfile` plus an optional `topology` (from sizing calculator when `--questionnaire` is provided).

Template sections (from design spec Section 12):

1. **Executive Summary** — tier, SLA result summary (pass/fail count), recommended deployment size (if topology provided)
2. **Benchmark Methodology** — static content: tool (k6), approach (ramp-to-saturation), monitoring (Coroot), duration, environment name from `{{environment}}`
3. **Agent Conversation Performance** — single-turn/multi-turn/tool-calling latencies from `services.runtime.scenarios`, concurrent capacity, error rate vs SLA targets
4. **Knowledge Base Performance** — ingestion throughput and vector search latency from `services['search-ai']` and `services['bge-m3']`, embedding throughput vs SLA
5. **Data Store Health** — per-store connection utilization, query latency, disk usage, status indicator (pass/warn/fail based on utilization thresholds)
6. **SLA Compliance Summary** — table of each SLA target vs measured result, pass/fail, delta from target. SLA targets passed in context as `slaTargets` array.
7. **Recommended Production Topology** — conditional `{{#if topology}}`: node pools, service replicas with CPU/memory, data store sizing. Uses `topology.services` and `topology.dataStores` arrays.
8. **Appendix** — test environment details, k6 script versions (from context `metadata`), Coroot collection window

The customer template must NOT expose: raw calibration numbers, hardcoded baselines, internal warnings, per-pod capacity ceilings, or Coroot metric names.

Estimated size: ~150-200 lines of Handlebars markdown.

- [ ] **Step 2: Commit**

```bash
npx prettier --write benchmarks/report/templates/customer.hbs
git add benchmarks/report/templates/customer.hbs
git commit -m "[ABLP-2] feat(sizing-calculator): add customer-facing saturation report Handlebars template"
```

---

## Task 4: Load Test Report Template

**Files:**

- Create: `benchmarks/report/templates/load-test.hbs`

- [ ] **Step 1: Create the load test report template**

Create `benchmarks/report/templates/load-test.hbs`. This template receives a context object with parsed k6 JSON summary data (per-service results, thresholds, metrics) and optional comparison data.

Template sections (from design spec Section 12):

1. **Summary** — tier, duration, total requests, overall error rate, services tested count, execution mode (local/cloud)
2. **Per-Service Results Table** — iterate `{{#each services}}`: service name, total requests, error rate, p50/p95/p99 latency, throughput (RPS), threshold pass/fail status
3. **Per-Service Detail** — `{{#each services}}` with: scenario breakdown table (per-scenario latency and throughput), custom metrics, threshold results with pass/fail indicators
4. **Integration Flow Results** — conditional `{{#if integrationFlows}}`: end-to-end latency, success rate, per-service contribution, bottleneck identification
5. **SLA Compliance** — each SLA target vs measured result, pass/fail, delta from target
6. **Comparison vs Previous Run** — conditional `{{#if comparison}}`: latency regressions (delta > 10% highlighted), throughput changes, new threshold failures highlighted

Key context shape (built by the CLI from k6 JSON output):

```typescript
interface LoadTestReportContext {
  tier: string;
  duration: string;
  totalRequests: number;
  overallErrorRate: number;
  executionMode: 'local' | 'cloud';
  timestamp: string;
  services: Array<{
    name: string;
    requests: number;
    errorRate: number;
    latency: { p50: number; p95: number; p99: number };
    throughputRps: number;
    thresholdsPassed: boolean;
    scenarios: Array<{
      name: string;
      requests: number;
      latency: { p50: number; p95: number; p99: number };
      throughputRps: number;
    }>;
  }>;
  integrationFlows?: Array<{
    name: string;
    e2eLatencyP95: number;
    successRate: number;
    bottleneck: string;
  }>;
  slaResults: Array<{
    target: string;
    threshold: string;
    measured: string;
    passed: boolean;
    delta: string;
  }>;
  comparison?: {
    previousTimestamp: string;
    regressions: Array<{
      service: string;
      metric: string;
      previous: number;
      current: number;
      deltaPercent: number;
    }>;
    improvements: Array<{
      service: string;
      metric: string;
      previous: number;
      current: number;
      deltaPercent: number;
    }>;
    newFailures: string[];
  };
}
```

Estimated size: ~180-220 lines of Handlebars markdown.

- [ ] **Step 2: Commit**

```bash
npx prettier --write benchmarks/report/templates/load-test.hbs
git add benchmarks/report/templates/load-test.hbs
git commit -m "[ABLP-2] feat(sizing-calculator): add load test report Handlebars template"
```

---

## Task 5: Report Generation CLI Commands

**Files:**

- Create: `packages/kore-platform-cli/src/commands/sizing-report.ts`
- Modify: `packages/kore-platform-cli/src/commands/sizing.ts`
- Modify: `packages/kore-platform-cli/package.json`

This is the main implementation task. It creates the `sizing report` and `sizing load-report` commands and all supporting functions: Handlebars compilation, template data extraction, PDF generation with graceful fallback.

- [ ] **Step 1: Add handlebars and md-to-pdf dependencies**

Add to `packages/kore-platform-cli/package.json`:

- `handlebars` as a **dependency** (not devDependency — needed at runtime for template compilation)
- `md-to-pdf` as a **dependency** (not devDependency — needed at runtime for PDF generation)
- `@types/handlebars` is NOT needed — `handlebars` ships its own types

```bash
cd packages/kore-platform-cli && pnpm add handlebars md-to-pdf
```

> **Dockerfile sync requirement (from CLAUDE.md):** When adding new workspace dependencies, verify that all Dockerfiles that run `pnpm install --frozen-lockfile` still resolve correctly. The `kore-platform-cli` package is referenced in `packages/kore-platform-cli/package.json` lines in these Dockerfiles: `apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile`, `apps/search-ai-runtime/Dockerfile`, `apps/multimodal-service/Dockerfile`, `packages/pipeline-engine/Dockerfile`. Since `handlebars` and `md-to-pdf` are npm registry packages (not workspace packages), no Dockerfile changes are needed — `pnpm install --frozen-lockfile` will resolve them from the lockfile. However, `pnpm-lock.yaml` MUST be committed so the lockfile stays in sync.

- [ ] **Step 2: Commit dependency addition**

```bash
npx prettier --write packages/kore-platform-cli/package.json
git add packages/kore-platform-cli/package.json pnpm-lock.yaml
git commit -m "[ABLP-2] chore(sizing-calculator): add handlebars and md-to-pdf dependencies to CLI"
```

- [ ] **Step 3: Create sizing-report.ts — Handlebars helpers and template loader**

Create `packages/kore-platform-cli/src/commands/sizing-report.ts`. Start with the template infrastructure:

```typescript
import type { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import Handlebars from 'handlebars';
```

All the following functions must be **individually exported** (not just `registerReportCommands`), because Plan 4's `sizing benchmark` command imports them directly for inline report generation when `--output-report` or `--output-pdf` flags are provided:

- `export function buildSaturationReportContext(...)` (Step 5)
- `export function buildLoadTestReportContext(...)` (Step 6)
- `export function generatePdf(...)` (Step 4)
- `export function loadTemplate(...)` (below)
- `export function registerHandlebarsHelpers()` (below)
- `export function registerReportCommands(...)` (Step 7)

> **Note:** Plan 4's `sizing benchmark` command imports these functions directly for inline report generation.

Implement the following functions in this step:

**`registerHandlebarsHelpers()`** — registers custom helpers:

- `formatMs(value: number)` — `< 1000` → `${value}ms`, else `${(value/1000).toFixed(1)}s`
- `formatPercent(value: number)` — `${value.toFixed(1)}%`
- `statusIcon(value: number, threshold: number)` — returns `PASS` if value <= threshold, `FAIL` otherwise
- `defaultVal(value: unknown, fallback: string)` — returns `fallback` if value is null/undefined
- `gt(a: number, b: number)` — greater-than comparison for `{{#if (gt a b)}}`
- `eq(a: unknown, b: unknown)` — equality for `{{#if (eq trigger "error-rate")}}`
- `json(value: unknown)` — `JSON.stringify(value, null, 2)` for debug output
- `serviceCount(services: Record<string, unknown>)` — `Object.keys(services).length`

**`loadTemplate(templateName: string)`** — resolves template path relative to the repo root `benchmarks/report/templates/${templateName}.hbs`, reads file, compiles with `Handlebars.compile()`. Uses `process.cwd()` to find the repo root (traverses up looking for `pnpm-workspace.yaml`).

**`findRepoRoot()`** — walks up from `process.cwd()` looking for `pnpm-workspace.yaml`. Returns the directory path. Throws if not found after 10 levels.

Estimated: ~80 lines.

- [ ] **Step 4: Add generatePdf() with graceful fallback**

Add to `sizing-report.ts`:

**`generatePdf(markdownPath: string, outputPath: string, stylesheetPath: string)`**

```typescript
async function generatePdf(
  markdownPath: string,
  outputPath: string,
  stylesheetPath: string,
): Promise<boolean> {
  try {
    // Dynamic import — md-to-pdf pulls in puppeteer which is heavy
    const { mdToPdf } = await import('md-to-pdf');

    const pdf = await mdToPdf(
      { path: markdownPath },
      {
        stylesheet: [stylesheetPath],
        pdf_options: {
          format: 'A4',
          margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
          displayHeaderFooter: true,
          headerTemplate:
            '<div style="font-size:8px;text-align:center;width:100%">ABL Platform — Confidential</div>',
          footerTemplate:
            '<div style="font-size:8px;text-align:center;width:100%"><span class="pageNumber"></span>/<span class="totalPages"></span></div>',
        },
      },
    );

    if (pdf?.content) {
      await writeFile(outputPath, pdf.content);
      return true;
    }
    return false;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`PDF generation skipped: ${message}`);
    console.warn('Install Chromium for PDF support. Markdown report was still generated.');
    return false;
  }
}
```

Key design points:

- Dynamic `import('md-to-pdf')` so the CLI does not fail at startup if Chromium is missing
- Returns `boolean` — caller checks and prints appropriate message
- Catches all errors (Chromium not found, Puppeteer timeout, etc.) and warns instead of crashing

Estimated: ~40 lines.

- [ ] **Step 5: Add buildSaturationReportContext() for internal + customer reports**

Add to `sizing-report.ts`:

**`buildSaturationReportContext(calibrationPath: string, questionnairePath?: string)`**

This function:

1. Reads and validates `calibration.json` using `CalibrationProfileSchema` from `@agent-platform/sizing-calculator`
2. Optionally reads and validates questionnaire JSON using `QuestionnaireSchema`
3. If questionnaire provided, calls `calculateTopology()` with calibration to get recommended topology
4. Computes `warnings` array by scanning the profile:
   - Any service with `measured.oomKills > 0` → warning
   - Any service with `measured.cpuPeak === null` → "Missing Coroot data" warning
   - Any data store with `connections.utilizationPercent > 80` → "High connection utilization" warning
   - Any scenario with disproportionate impact (scenario maxRps < 50% of blended maxRps) → warning
5. Computes `slaTargets` from standard platform SLAs (hardcoded defaults; could be configurable later)
6. Returns context object suitable for both internal and customer templates

```typescript
interface SaturationReportContext {
  // From CalibrationProfile
  version: string;
  tier: string;
  timestamp: string;
  environment: string;
  services: Record<string, ServiceCapacity>;
  dataStores: Record<string, DataStoreCapacity>;
  integrationFlows?: Record<string, IntegrationFlowCapacity>;

  // Computed
  serviceCount: number;
  dataStoreCount: number;
  warnings: Array<{ level: 'error' | 'warn' | 'info'; service: string; message: string }>;
  slaTargets: Array<{
    name: string;
    target: string;
    measured: string;
    passed: boolean;
    delta: string;
  }>;

  // Optional (when questionnaire provided)
  topology?: Topology;

  // Metadata
  generatedAt: string;
  calibrationPath: string;
}
```

Estimated: ~100 lines.

- [ ] **Step 6: Add buildLoadTestReportContext() for load-report command**

Add to `sizing-report.ts`:

**`buildLoadTestReportContext(resultsDir: string, compareDir?: string)`**

This function:

1. Scans `resultsDir` for k6 JSON summary files (pattern: `*-summary.json` or `summary.json`)
2. Parses each JSON summary — k6 outputs structured JSON with `metrics`, `root_group`, `options`
3. Extracts per-service results: maps k6 groups/tags to service names, computes latency percentiles, throughput, error rates
4. Extracts threshold results (k6 `thresholds` object) and maps to pass/fail
5. If `compareDir` provided, parses previous results and computes deltas:
   - Latency regressions: current p95 > previous p95 by > 10%
   - Throughput improvements/regressions
   - New threshold failures not present in previous run
6. Computes SLA compliance from measured values vs standard targets
7. Returns `LoadTestReportContext` (shape defined in Task 4 Step 1)

> **Note:** Cloud mode (`--cloud`) is out of scope for Plan 5. It requires Grafana Cloud k6 API integration. The `--cloud` flag will be added in a follow-up. For now, `--results` (local) is the supported path.

Estimated: ~120 lines.

- [ ] **Step 7: Add `sizing report` command registration**

Add to `sizing-report.ts`:

**`registerReportCommands(sizing: Command)`** — takes the `sizing` parent command and registers subcommands.

First subcommand — `sizing report`:

```typescript
sizing
  .command('report')
  .description('Generate saturation/calibration reports from a CalibrationProfile')
  .requiredOption('--calibration <path>', 'Path to calibration.json')
  .option('--questionnaire <path>', 'Path to questionnaire JSON (enables topology section)')
  .option('--format <formats>', 'Output formats: md, pdf, or md,pdf', 'md')
  .option('--output-dir <path>', 'Output directory (default: stdout for md-only)')
  .action(async (opts) => {
    /* ... */
  });
```

Action implementation:

1. Call `registerHandlebarsHelpers()`
2. Call `buildSaturationReportContext(opts.calibration, opts.questionnaire)`
3. Load and render `internal.hbs` template with context → internal markdown
4. Load and render `customer.hbs` template with context → customer markdown
5. Parse `--format` to determine outputs (`md`, `pdf`, or both)
6. If `--output-dir`:
   - Create directory with `mkdir({ recursive: true })`
   - Write `internal-report.md` and `customer-report.md`
   - If format includes `pdf`, call `generatePdf()` for customer report (internal stays markdown-only per design spec: "customer reports also as PDF")
   - Print summary: files generated, any PDF warnings
7. If no `--output-dir` and format is `md`: print customer report to stdout
8. If no `--output-dir` and format includes `pdf`: error — `--output-dir` required for PDF output

Estimated: ~60 lines.

- [ ] **Step 8: Add `sizing load-report` command registration**

Add to `registerReportCommands()`:

Second subcommand — `sizing load-report`:

```typescript
sizing
  .command('load-report')
  .description('Generate load test report from k6 results')
  .option('--results <path>', 'Local k6 results directory (/tmp/k6-suite-*/)')
  .option('--cloud', 'Fetch from Grafana Cloud k6 (not yet implemented)')
  .option('--last <n>', 'Number of recent cloud runs', '1')
  .option('--compare <path>', 'Previous results directory for regression comparison')
  .option('--format <formats>', 'Output formats: md, pdf, or md,pdf', 'md')
  .option('--output-dir <path>', 'Output directory')
  .action(async (opts) => {
    /* ... */
  });
```

Action implementation:

1. Validate: one of `--results` or `--cloud` must be provided
2. If `--cloud`: print "Cloud mode not yet implemented. Use --results with a local k6 results directory." and exit with code 1
3. Call `registerHandlebarsHelpers()`
4. Call `buildLoadTestReportContext(opts.results, opts.compare)`
5. Load and render `load-test.hbs` template with context → markdown
6. If `--output-dir`:
   - Create directory
   - Write `load-test-report.md`
   - If format includes `pdf`, call `generatePdf()` for the load test report
   - Print summary
7. If no `--output-dir` and format is `md`: print to stdout

Estimated: ~50 lines.

- [ ] **Step 9: Build and verify types compile**

Run: `pnpm build --filter=@agent-platform/cli`
Expected: SUCCESS — no type errors

- [ ] **Step 10: Commit sizing-report.ts**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/sizing-report.ts
git add packages/kore-platform-cli/src/commands/sizing-report.ts
git commit -m "[ABLP-2] feat(sizing-calculator): add sizing report and load-report CLI commands"
```

---

## Task 6: Wire Report Commands into sizing.ts

**Files:**

- Modify: `packages/kore-platform-cli/src/commands/sizing.ts`

- [ ] **Step 1: Import and register report commands**

In `packages/kore-platform-cli/src/commands/sizing.ts`, add:

```typescript
import { registerReportCommands } from './sizing-report.js';
```

At the end of `registerSizingCommands()`, after the existing `helm` command registration, call:

```typescript
registerReportCommands(sizing);
```

The `sizing` variable is the parent command created at the top of `registerSizingCommands()`. The `registerReportCommands` function receives it and adds `report` and `load-report` as subcommands.

- [ ] **Step 2: Build and verify**

Run: `pnpm build --filter=@agent-platform/cli`
Expected: SUCCESS

- [ ] **Step 3: Verify CLI help output**

Run: `npx kore-platform-cli sizing --help`
Expected: Shows `report`, `load-report` alongside existing `questionnaire`, `calculate`, `helm` commands.

Run: `npx kore-platform-cli sizing report --help`
Expected: Shows `--calibration`, `--questionnaire`, `--format`, `--output-dir` options.

Run: `npx kore-platform-cli sizing load-report --help`
Expected: Shows `--results`, `--cloud`, `--last`, `--compare`, `--format`, `--output-dir` options.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/kore-platform-cli/src/commands/sizing.ts
git add packages/kore-platform-cli/src/commands/sizing.ts
git commit -m "[ABLP-2] feat(sizing-calculator): wire report commands into sizing CLI"
```

---

## Task 7: Smoke Test — Generate Sample Reports

> This task validates that templates render correctly and PDF generation works (or gracefully degrades). No unit tests — report output is validated visually.

- [ ] **Step 1: Generate saturation reports from fixture data**

Use the calibration fixture from Plan 1 (`packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json`):

```bash
mkdir -p /tmp/report-test

npx kore-platform-cli sizing report \
  --calibration packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json \
  --format md \
  --output-dir /tmp/report-test/
```

Expected:

- `/tmp/report-test/internal-report.md` exists and contains all 8 sections (Executive Summary through Warnings)
- `/tmp/report-test/customer-report.md` exists and contains all 8 sections (Executive Summary through Appendix)
- No runtime errors

Verify content quality:

- Tables render correctly (proper markdown table syntax)
- Service names from the fixture (`runtime`, `search-ai`) appear in tables
- Data store names (`mongodb`, `redis`) appear in data store sections
- Null Coroot values display as "N/A" (not "null")
- Warnings section lists relevant warnings (if any from fixture data)

- [ ] **Step 2: Test PDF generation (or graceful fallback)**

```bash
npx kore-platform-cli sizing report \
  --calibration packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json \
  --format md,pdf \
  --output-dir /tmp/report-test/
```

Expected (if Chromium available):

- `/tmp/report-test/customer-report.pdf` exists
- PDF is readable with correct styling (headers, tables, colors)

Expected (if Chromium NOT available):

- Warning printed: "PDF generation skipped: ..."
- Markdown files still generated successfully
- CLI exits with code 0 (not an error)

- [ ] **Step 3: Test with questionnaire for topology section**

```bash
# Generate a questionnaire first
npx kore-platform-cli sizing questionnaire --output /tmp/report-test/q.json

npx kore-platform-cli sizing report \
  --calibration packages/sizing-calculator/src/__tests__/fixtures/calibration-m.json \
  --questionnaire /tmp/report-test/q.json \
  --format md \
  --output-dir /tmp/report-test-with-topo/
```

Expected:

- Customer report includes "Recommended Production Topology" section with node pools and service replicas
- Internal report includes topology comparison data

- [ ] **Step 4: Test load-report with --cloud flag (expect not-implemented message)**

```bash
npx kore-platform-cli sizing load-report --cloud --format md
```

Expected: Prints "Cloud mode not yet implemented" message and exits with code 1.

- [ ] **Step 5: Test load-report error handling (no --results or --cloud)**

```bash
npx kore-platform-cli sizing load-report --format md 2>&1 || true
```

Expected: Error message indicating one of `--results` or `--cloud` is required.

---

## Task 8: Final Verification

- [ ] **Step 1: Run CLI build**

Run: `pnpm build --filter=@agent-platform/cli`
Expected: SUCCESS — no type errors

- [ ] **Step 2: Run typecheck**

Run: `cd packages/kore-platform-cli && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run existing CLI tests (no regressions)**

Run: `cd packages/kore-platform-cli && pnpm test`
Expected: ALL existing tests pass

- [ ] **Step 4: Verify all new files are committed**

Run: `git status`
Expected: Clean working tree (all new files committed)

---

## Summary

| Task | What It Produces                                    | Verification                       |
| ---- | --------------------------------------------------- | ---------------------------------- |
| 1    | Customer report CSS                                 | Visual (PDF output in Task 7)      |
| 2    | Internal saturation template                        | Sample report generation (Task 7)  |
| 3    | Customer saturation template                        | Sample report generation (Task 7)  |
| 4    | Load test report template                           | Sample report generation (Task 7)  |
| 5    | `sizing report` + `sizing load-report` CLI commands | Build + CLI help + sample reports  |
| 6    | Wire into sizing.ts                                 | Build + CLI help                   |
| 7    | Smoke test all report types                         | Manual verification                |
| 8    | Final verification                                  | Build + typecheck + existing tests |

**Total new files:** 5 (3 templates + 1 CSS + 1 TS command file)
**Total modified files:** 2 (`sizing.ts`, `package.json`)
**Total new tests:** 0 (templates verified by smoke test; report logic is thin glue code around Handlebars + md-to-pdf)
