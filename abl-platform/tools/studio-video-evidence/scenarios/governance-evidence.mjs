/**
 * Governance feature evidence capture.
 *
 * Creates a project, seeds policies via API + inserts ClickHouse quality evaluation data,
 * then captures all 4 governance tabs with real populated data.
 *
 * Usage:
 *   pnpm studio:video:evidence -- --scenario governance-evidence
 */

import { createStudioFixture } from '../lib/studio-harness.mjs';
import { waitForIdle } from '../lib/studio-chat.mjs';

const REQUEST_TIMEOUT_MS = 30_000;
const CLICKHOUSE_URL = 'http://abl_admin:abl_dev_password@localhost:8124';

async function apiPost(baseUrl, path, token, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function insertClickHouseRows(projectId, tenantId) {
  const now = Date.now();
  const rows = [];

  // 80 PASSING rows (overall_score=0.85, helpfulness=0.82, accuracy=0.90)
  for (let i = 0; i < 80; i++) {
    const ts = new Date(now - i * 3_600_000).toISOString().replace('T', ' ').replace('Z', '');
    rows.push(
      `('${tenantId}','${projectId}','session-p${i}','${ts}','${ts}',` +
        `'agent-default','v1','web',0.85,0.82,0.90,0.80,0.78,'{}',0,[],` +
        `'','claude-3-5-sonnet',1,'1.0',0.9,1200,300,400,'studio','','quality_evaluation')`,
    );
  }

  // 20 FAILING rows (overall_score=0.60, helpfulness=0.55, accuracy=0.65)
  for (let i = 80; i < 100; i++) {
    const ts = new Date(now - i * 3_600_000).toISOString().replace('T', ' ').replace('Z', '');
    rows.push(
      `('${tenantId}','${projectId}','session-f${i}','${ts}','${ts}',` +
        `'agent-default','v1','web',0.60,0.55,0.65,0.50,0.48,'{}',1,['low_quality'],` +
        `'','claude-3-5-sonnet',1,'1.0',0.6,1800,280,350,'studio','','quality_evaluation')`,
    );
  }

  const cols =
    'tenant_id,project_id,session_id,session_started_at,processed_at,' +
    'agent_name,agent_version,channel,overall_score,helpfulness,accuracy,' +
    'professionalism,instruction_following,custom_dimensions,flagged,flag_reasons,' +
    'reasoning,model_id,config_version,pipeline_version,confidence,processing_ms,' +
    'input_tokens,output_tokens,source,pipeline_id,pipeline_type';

  const sql = `INSERT INTO abl_platform.quality_evaluations (${cols}) VALUES ${rows.join(',')}`;

  const chUrl = new URL(CLICKHOUSE_URL);
  const auth = `${chUrl.username}:${chUrl.password}`;
  const host = `${chUrl.protocol}//${chUrl.hostname}:${chUrl.port}`;

  const res = await fetch(`${host}/?async_insert=1&wait_for_async_insert=1`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(auth).toString('base64')}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickHouse insert failed: ${err.slice(0, 300)}`);
  }
}

async function clickTab(page, label) {
  const tab = page.getByRole('tab', { name: new RegExp(label, 'i') }).first();
  if (await tab.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await tab.click();
    await waitForIdle(page, 1_200);
  }
}

export const scenario = {
  id: 'governance-evidence',
  title: 'Governance Feature Evidence',
  description: 'Captures all governance tabs with seeded policy + real ClickHouse quality data.',

  async run(context) {
    const { page, baseUrl, artifacts, log } = context;

    // 1. Login + create project
    log('Creating Studio fixture...');
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: false,
    });
    const { accessToken, projectId } = fixture;
    // Extract tenantId from JWT payload
    let tenantId = null;
    try {
      const payload = JSON.parse(
        Buffer.from(accessToken.split('.')[1], 'base64').toString('utf-8'),
      );
      tenantId = payload.tenantId;
    } catch {}
    log(`Project: ${projectId}  Tenant: ${tenantId}`);

    // 2. Seed governance policies via runtime API
    log('Creating governance policies...');
    const p1 = await apiPost(
      context.runtimeBaseUrl,
      `/api/projects/${projectId}/governance/policies`,
      accessToken,
      {
        name: 'Quality Gate — Critical',
        status: 'enabled',
        rules: [
          {
            pipelineType: 'quality_evaluation',
            metric: 'overall_score',
            operator: 'gte',
            threshold: 0.8,
            severity: 'critical',
          },
          {
            pipelineType: 'quality_evaluation',
            metric: 'helpfulness',
            operator: 'gte',
            threshold: 0.7,
            severity: 'warning',
          },
        ],
      },
    );
    log(`Policy 1: ${p1?.data?._id}`);

    const p2 = await apiPost(
      context.runtimeBaseUrl,
      `/api/projects/${projectId}/governance/policies`,
      accessToken,
      {
        name: 'Accuracy Monitor',
        status: 'enabled',
        rules: [
          {
            pipelineType: 'quality_evaluation',
            metric: 'accuracy',
            operator: 'gte',
            threshold: 0.75,
            severity: 'warning',
          },
        ],
      },
    );
    log(`Policy 2: ${p2?.data?._id}`);

    // 3. Insert ClickHouse quality evaluation data (80 passing + 20 failing rows)
    log('Inserting ClickHouse quality data (100 rows)...');
    await insertClickHouseRows(projectId, tenantId);
    await new Promise((r) => setTimeout(r, 800)); // allow async_insert flush
    log('ClickHouse data ready.');

    // 4. Navigate to governance page
    const govUrl = `${baseUrl}/projects/${projectId}/governance`;
    log(`Navigating to ${govUrl}`);
    await page.goto(govUrl, { waitUntil: 'domcontentloaded' });
    await waitForIdle(page, 2_000);
    await page.locator('main').first().waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
    await waitForIdle(page, 2_000);

    // 5. Agent Registry tab
    log('Capturing Agent Registry tab...');
    await clickTab(page, 'Agent Registry');
    await waitForIdle(page, 2_000);
    await artifacts.captureScreenshot('governance-registry.png');

    // 6. New Policy modal
    const newPolicyBtn = page.getByRole('button', { name: /new policy/i }).first();
    if (await newPolicyBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await newPolicyBtn.click();
      await waitForIdle(page, 1_500);
      await artifacts.captureScreenshot('governance-new-policy-modal.png');
      await page.keyboard.press('Escape');
      await waitForIdle(page, 800);
    }

    // 7. Compliance tab
    log('Capturing Compliance tab...');
    await clickTab(page, 'Compliance');
    await waitForIdle(page, 3_500);
    await artifacts.captureScreenshot('governance-compliance.png');

    // 8. Audit Trail tab
    log('Capturing Audit Trail tab...');
    await clickTab(page, 'Audit Trail');
    await waitForIdle(page, 2_500);
    await artifacts.captureScreenshot('governance-audit.png');

    // 9. Frameworks tab
    log('Capturing Frameworks tab...');
    await clickTab(page, 'Frameworks');
    await waitForIdle(page, 3_500);
    await artifacts.captureScreenshot('governance-frameworks.png');

    return {
      summary: 'Captured governance tabs with 100 quality eval rows seeded in ClickHouse.',
      projectId,
      tenantId,
    };
  },
};
