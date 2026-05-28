/**
 * Document Extraction Saturation Benchmark — ABLP-1073 / Phase 5.
 *
 * Ramp-to-saturation k6 script that drives the workflow-engine through
 * `extract_document` connector_action steps via the Docling and/or Azure DI
 * provider. Each iteration triggers a pre-deployed extraction workflow and
 * polls for completion, recording end-to-end park duration vs. the HLD §4.3
 * SLO targets (p95 ≤ 25 s Docling, ≤ 20 s Azure DI).
 *
 * Two scenarios (blended weights — override via SCENARIO_WEIGHTS env):
 *   1. docling_extraction (60%) — exercises the native Docling connector
 *   2. azure_di_extraction (40%) — exercises the AP-format Azure DI piece
 *
 * Setup expectations (pre-run, NOT done by the script):
 *   - A target tenant has `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=true`.
 *   - A workflow exists named `bench-docling-extract` with a single
 *     `extract_document` step pointing at the Docling connector. Its ID is
 *     surfaced via `BENCH_DOCLING_WORKFLOW_ID` env var.
 *   - A workflow exists named `bench-azure-di-extract` with a single
 *     `extract_document` step pointing at the Azure DI piece. Its ID is
 *     surfaced via `BENCH_AZURE_DI_WORKFLOW_ID` env var. Skipped if absent.
 *   - A set of test document URLs lives at `BENCH_TEST_DOCUMENT_URLS` (CSV)
 *     — sub-1MB to 25MB PDFs are recommended. Defaults to a small sample.
 *
 * Credentials: the Azure DI subscription key is NOT read by k6. It must be
 * provisioned on the workflow's `ConnectorConnection` via the Studio UI or
 * `/api/projects/:projectId/integrations` route BEFORE the test runs.
 *
 * Run:
 *   k6 run benchmarks/saturation/document-extraction.ts \
 *     -e WORKFLOW_ENGINE_URL=https://staging.example.com/api/workflow-engine \
 *     -e PROJECT_ID=p-bench-1 \
 *     -e BENCH_DOCLING_WORKFLOW_ID=wf-docling-abc \
 *     -e BENCH_AZURE_DI_WORKFLOW_ID=wf-azure-di-xyz \
 *     -e MAX_VUS=80 \
 *     -e DURATION_MINUTES=15 \
 *     -e BENCH_TEST_DOCUMENT_URLS=https://example.com/a.pdf,https://example.com/b.pdf
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config, apiPath, runHealthCheck } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { successRate, errorCount } from '../lib/metrics.ts';
import { buildBlendedScenarios } from '../lib/saturation-utils.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Workflow-engine base URL. Falls back to the runtime URL only for dev convenience. */
const WORKFLOW_ENGINE_URL = __ENV.WORKFLOW_ENGINE_URL || 'http://localhost:3115';

const PROJECT_ID = __ENV.PROJECT_ID || config.projectId;

/** Pre-deployed workflow IDs. Both optional — scenarios skip when their ID is absent. */
const DOCLING_WORKFLOW_ID = __ENV.BENCH_DOCLING_WORKFLOW_ID || '';
const AZURE_DI_WORKFLOW_ID = __ENV.BENCH_AZURE_DI_WORKFLOW_ID || '';

/** CSV list of source-document URLs used round-robin across iterations. */
const TEST_DOC_URLS = (__ENV.BENCH_TEST_DOCUMENT_URLS || '')
  .split(',')
  .map((u) => u.trim())
  .filter((u) => u.length > 0);

const MAX_VUS = parseInt(__ENV.MAX_VUS || '80', 10);
const DURATION_MINUTES = parseInt(__ENV.DURATION_MINUTES || '15', 10);

/** Polling interval (ms) and per-execution wall-clock cap. */
const POLL_INTERVAL_MS = parseInt(__ENV.POLL_INTERVAL_MS || '1500', 10);
const POLL_DEADLINE_MS = parseInt(__ENV.POLL_DEADLINE_MS || '60000', 10);

/** Custom scenario weights (JSON: `{ docling_extraction: 70, azure_di_extraction: 30 }`). */
const CUSTOM_WEIGHTS: Record<string, number> | undefined = __ENV.SCENARIO_WEIGHTS
  ? (JSON.parse(__ENV.SCENARIO_WEIGHTS) as Record<string, number>)
  : undefined;

// ---------------------------------------------------------------------------
// Custom Metrics — per-provider end-to-end latency + outcome counters
// ---------------------------------------------------------------------------

const doclingEndToEndMs = new Trend('extraction_docling_e2e_ms', true);
const azureDIEndToEndMs = new Trend('extraction_azure_di_e2e_ms', true);
const executionTriggerMs = new Trend('extraction_trigger_ms', true);
const extractionSuccess = new Counter('extraction_success_total');
const extractionFailure = new Counter('extraction_failure_total');
const extractionTimeout = new Counter('extraction_timeout_total');
const extractionSuccessRate = new Rate('extraction_success_rate');

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIO_EXEC_MAP = {
  docling_extraction: 'doclingExtraction',
  azure_di_extraction: 'azureDIExtraction',
};

export const options: Options = {
  scenarios: buildBlendedScenarios(
    'document-extraction',
    MAX_VUS,
    SCENARIO_EXEC_MAP,
    DURATION_MINUTES,
    CUSTOM_WEIGHTS,
  ) as Options['scenarios'],
  thresholds: {
    // HLD §4.3 SLO targets — p95 latency caps per provider.
    extraction_docling_e2e_ms: ['p(95)<25000', 'p(99)<60000'],
    extraction_azure_di_e2e_ms: ['p(95)<20000', 'p(99)<60000'],
    // Trigger (POST /execute) must stay snappy — workflow engine should
    // accept the request quickly and let the worker do the heavy lifting.
    extraction_trigger_ms: ['p(95)<500', 'p(99)<2000'],
    // Saturation alert thresholds — reject the run if extraction-success
    // drops below 95% (matches the FR-16 callback success budget).
    extraction_success_rate: ['rate>0.95'],
    http_req_failed: ['rate<0.05'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'document-extraction-saturation',
    tags: {
      service: 'workflow-engine,search-ai',
      type: 'saturation',
      feature: 'document-extraction',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
  doclingWorkflowId: string;
  azureDIWorkflowId: string;
  docUrls: string[];
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  runHealthCheck(WORKFLOW_ENGINE_URL, 'workflow-engine', headers);

  if (!DOCLING_WORKFLOW_ID && !AZURE_DI_WORKFLOW_ID) {
    throw new Error(
      'BENCH_DOCLING_WORKFLOW_ID and BENCH_AZURE_DI_WORKFLOW_ID are both empty. ' +
        'Pre-deploy at least one extraction workflow before running this benchmark.',
    );
  }

  if (TEST_DOC_URLS.length === 0) {
    console.warn(
      '[setup] BENCH_TEST_DOCUMENT_URLS is empty — using a single tiny default. ' +
        'For meaningful saturation pass a CSV of sub-1MB to 25MB PDF URLs.',
    );
  }

  return {
    token,
    refreshToken,
    headers,
    doclingWorkflowId: DOCLING_WORKFLOW_ID,
    azureDIWorkflowId: AZURE_DI_WORKFLOW_ID,
    docUrls:
      TEST_DOC_URLS.length > 0
        ? TEST_DOC_URLS
        : [
            // 200-byte synthetic placeholder — exercises the pipeline shape only;
            // replace with real PDFs via BENCH_TEST_DOCUMENT_URLS for true saturation.
            'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
          ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TriggerOutcome {
  executionId: string | undefined;
  triggerLatencyMs: number;
  status: number;
}

function triggerExtraction(data: SetupData, workflowId: string, fileUrl: string): TriggerOutcome {
  const start = Date.now();
  const res = http.post(
    `${WORKFLOW_ENGINE_URL}${apiPath('/workflows/execute')}`,
    JSON.stringify({
      workflowId,
      projectId: PROJECT_ID,
      triggerType: 'http',
      triggerPayload: { fileUrl, ts: start },
    }),
    {
      headers: { ...freshHeaders(data), 'Content-Type': 'application/json' },
      tags: { name: 'POST /workflows/execute' },
    },
  );
  const triggerLatencyMs = Date.now() - start;
  executionTriggerMs.add(triggerLatencyMs);

  const body = (() => {
    try {
      return res.json() as Record<string, unknown>;
    } catch {
      return undefined;
    }
  })();
  const executionId =
    typeof body?.executionId === 'string'
      ? (body.executionId as string)
      : typeof (body?.data as { executionId?: string } | undefined)?.executionId === 'string'
        ? (body!.data as { executionId: string }).executionId
        : undefined;

  return { executionId, triggerLatencyMs, status: res.status };
}

interface CompletionOutcome {
  terminalStatus: string | undefined; // 'completed' | 'failed' | 'timeout' | 'cancelled' | 'unknown'
  pollAttempts: number;
}

function pollUntilComplete(data: SetupData, executionId: string): CompletionOutcome {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const res = http.get(
      `${WORKFLOW_ENGINE_URL}${apiPath(`/workflows/executions/${executionId}`)}`,
      {
        headers: freshHeaders(data),
        tags: { name: 'GET /workflows/executions/:id' },
      },
    );
    if (res.status === 200) {
      const body = res.json() as Record<string, unknown> | undefined;
      const status =
        typeof body?.status === 'string'
          ? (body.status as string)
          : typeof (body?.data as { status?: string } | undefined)?.status === 'string'
            ? (body!.data as { status: string }).status
            : undefined;
      if (status && ['completed', 'failed', 'cancelled'].includes(status)) {
        return { terminalStatus: status, pollAttempts: attempts };
      }
    }
    sleep(POLL_INTERVAL_MS / 1000);
  }
  return { terminalStatus: 'timeout', pollAttempts: attempts };
}

function recordOutcome(
  provider: 'docling' | 'azure-di',
  outcome: CompletionOutcome,
  e2eMs: number,
): void {
  if (outcome.terminalStatus === 'completed') {
    extractionSuccess.add(1, { provider });
    extractionSuccessRate.add(true);
    if (provider === 'docling') doclingEndToEndMs.add(e2eMs);
    else azureDIEndToEndMs.add(e2eMs);
  } else if (outcome.terminalStatus === 'timeout') {
    extractionTimeout.add(1, { provider });
    extractionSuccessRate.add(false);
    errorCount.add(1);
  } else {
    extractionFailure.add(1, { provider, status: outcome.terminalStatus ?? 'unknown' });
    extractionSuccessRate.add(false);
    errorCount.add(1);
  }
  successRate.add(outcome.terminalStatus === 'completed' ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Scenario 1: Docling extraction
// ---------------------------------------------------------------------------

export function doclingExtraction(data: SetupData): void {
  if (!data.doclingWorkflowId) {
    sleep(1);
    return;
  }
  ensureFreshAuth(data);

  const fileUrl = data.docUrls[__ITER % data.docUrls.length];
  const start = Date.now();

  const trigger = triggerExtraction(data, data.doclingWorkflowId, fileUrl);
  const triggerOk = check(trigger, {
    'trigger accepted (2xx)': (t) => t.status >= 200 && t.status < 300,
    'executionId returned': (t) => !!t.executionId,
  });
  if (!triggerOk || !trigger.executionId) {
    extractionFailure.add(1, { provider: 'docling', status: 'trigger_failed' });
    extractionSuccessRate.add(false);
    return;
  }

  const completion = pollUntilComplete(data, trigger.executionId);
  const e2eMs = Date.now() - start;
  recordOutcome('docling', completion, e2eMs);
}

// ---------------------------------------------------------------------------
// Scenario 2: Azure DI extraction
// ---------------------------------------------------------------------------

export function azureDIExtraction(data: SetupData): void {
  if (!data.azureDIWorkflowId) {
    sleep(1);
    return;
  }
  ensureFreshAuth(data);

  const fileUrl = data.docUrls[__ITER % data.docUrls.length];
  const start = Date.now();

  const trigger = triggerExtraction(data, data.azureDIWorkflowId, fileUrl);
  const triggerOk = check(trigger, {
    'trigger accepted (2xx)': (t) => t.status >= 200 && t.status < 300,
    'executionId returned': (t) => !!t.executionId,
  });
  if (!triggerOk || !trigger.executionId) {
    extractionFailure.add(1, { provider: 'azure-di', status: 'trigger_failed' });
    extractionSuccessRate.add(false);
    return;
  }

  const completion = pollUntilComplete(data, trigger.executionId);
  const e2eMs = Date.now() - start;
  recordOutcome('azure-di', completion, e2eMs);
}

// ---------------------------------------------------------------------------
// Default — falls back to docling so `k6 run` without a scenario doesn't no-op
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  doclingExtraction(data);
}
