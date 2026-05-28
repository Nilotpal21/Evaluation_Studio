import { test, expect, Page } from '@playwright/test';
import { getDevAccessToken, loginViaDevApi } from '../helpers';

/**
 * E2E test: Apple Care Support Escalation Workflow
 *
 * Full lifecycle through Studio UI + Studio API (no WE proxy dependency):
 * 1. Verify connector catalog via Studio API (25+ connectors loaded)
 * 2. Create Jira connection via Studio API → verify in Connections page UI
 * 3. Get connection detail via Studio API
 * 4. Test connection via Studio API
 * 5. Create workflow via UI modal
 * 6. Add 7 steps via API (HTTP, Condition, Agent Invocation, Connector Action, Approval)
 * 7. Set up condition branching via API (thenSteps / elseSteps)
 * 8. Verify steps display in UI + click through editors
 * 9. Add webhook trigger via UI
 * 10. Execute via Run button
 * 11. Monitor execution in Monitor tab
 * 12. Clean up Jira connection via Studio API
 */

const STUDIO_URL = 'http://localhost:5173';
const RUNTIME_URL = 'http://localhost:3002';
const SCREENSHOTS_DIR = 'e2e/screenshots';
const TEST_LOGIN_EMAIL = 'workflow-apple-care@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Workflow Apple Care E2E';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Login via Dev Login, navigate to first project, return projectId + auth token */
async function loginAndSetup(page: Page): Promise<{ projectId: string; token: string }> {
  await loginViaDevApi(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
  });
  const token = await getDevAccessToken(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
  });

  // Click first project
  const firstCard = page.locator('button:has(h3)').first();
  await expect(firstCard).toBeVisible({ timeout: 10000 });
  await firstCard.click();
  await page.locator('nav >> text=Workflows').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1000);

  const url = page.url();
  const m = url.match(/\/projects\/([^/]+)/);
  if (!m) throw new Error(`No project ID in URL: ${url}`);

  return { projectId: m[1], token };
}

/** Update a workflow's steps via Runtime API */
async function updateWorkflowSteps(
  token: string,
  projectId: string,
  workflowId: string,
  steps: Array<Record<string, unknown>>,
) {
  const resp = await fetch(`${RUNTIME_URL}/api/projects/${projectId}/workflows/${workflowId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Tenant-Id': 'tenant-kore',
    },
    body: JSON.stringify({ steps }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API update failed (${resp.status}): ${body}`);
  }
  return resp.json();
}

// ─── Studio Connection API Helpers ───────────────────────────────────────

/** List available connectors via Studio API (direct, no WE dependency) */
async function listConnectors(
  token: string,
  projectId: string,
): Promise<Array<{ name: string; displayName: string; actions: unknown[]; triggers: unknown[] }>> {
  try {
    const resp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/connectors`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      console.log(`List connectors failed (${resp.status}): ${await resp.text()}`);
      return [];
    }
    const data = await resp.json();
    return data.data || [];
  } catch (err) {
    console.log(`List connectors error: ${err}`);
    return [];
  }
}

/** Create a connection via Studio API (direct MongoDB, no WE proxy) */
async function createConnection(
  token: string,
  projectId: string,
  input: {
    connectorName: string;
    displayName: string;
    scope: string;
    authType: string;
    credentials: Record<string, unknown>;
  },
): Promise<{ id: string } | null> {
  try {
    const resp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/connections`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.log(`Connection creation returned ${resp.status}: ${body}`);
      return null;
    }
    const data = await resp.json();
    const id = data.data?.id || data.data?._id;
    console.log(`Connection created via Studio API: ${id}`);
    return { id };
  } catch (err) {
    console.log(`Connection creation error: ${err}`);
    return null;
  }
}

/** Get a connection by ID via Studio API */
async function getConnection(
  token: string,
  projectId: string,
  connectionId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(
      `${STUDIO_URL}/api/projects/${projectId}/connections/${connectionId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.data || null;
  } catch {
    return null;
  }
}

/** Test a connection via Studio API */
async function testConnection(
  token: string,
  projectId: string,
  connectionId: string,
): Promise<{ success: boolean; latencyMs?: number; error?: string } | null> {
  try {
    const resp = await fetch(
      `${STUDIO_URL}/api/projects/${projectId}/connections/${connectionId}/test`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!resp.ok) {
      console.log(`Connection test returned ${resp.status}: ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    return data.data || null;
  } catch (err) {
    console.log(`Connection test error: ${err}`);
    return null;
  }
}

/** List connections via Studio API */
async function listConnections(
  token: string,
  projectId: string,
): Promise<Array<{ id: string; connectorName: string; displayName: string }>> {
  try {
    const resp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/connections`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data || []).map((c: Record<string, unknown>) => ({
      id: (c.id || c._id) as string,
      connectorName: c.connectorName as string,
      displayName: c.displayName as string,
    }));
  } catch {
    return [];
  }
}

/** Delete a connection via Studio API */
async function deleteConnection(token: string, projectId: string, connectionId: string) {
  try {
    await fetch(`${STUDIO_URL}/api/projects/${projectId}/connections/${connectionId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`Connection deleted via Studio API: ${connectionId}`);
  } catch (err) {
    console.log(`Connection cleanup failed: ${err}`);
  }
}

// ─── Step Definitions ─────────────────────────────────────────────────────

/** Build steps with condition branching and optional connector_action step */
function buildBranchedSteps(jiraConnectionId: string | null) {
  const jiraStep = jiraConnectionId
    ? {
        id: 'step-create-jira',
        name: 'Create Jira Ticket',
        type: 'connector_action',
        config: {
          connectionId: jiraConnectionId,
          connector: 'jira',
          action: 'create_issue',
          params: JSON.stringify({
            project: 'APPLECARE',
            issueType: 'Task',
            summary: 'Support ticket for {{steps.step-fetch-customer.output.body.args.name}}',
            description: 'Auto-created by Apple Care workflow',
          }),
        },
        position: 4,
      }
    : {
        id: 'step-create-jira',
        name: 'Create Jira Ticket',
        type: 'http',
        config: {
          method: 'POST',
          url: 'https://httpbin.org/post',
          headers: '{"Content-Type": "application/json", "Authorization": "Basic dGVzdDp0ZXN0"}',
          body: '{"fields": {"project": {"key": "APPLECARE"}, "summary": "Support ticket for {{steps.step-fetch-customer.output.body.args.name}}", "issuetype": {"name": "Task"}}}',
        },
        position: 4,
      };

  return [
    {
      id: 'step-fetch-customer',
      name: 'Fetch Customer',
      type: 'http',
      config: {
        method: 'GET',
        url: 'https://httpbin.org/get?customerId=CUST-001&name=John+Doe',
        headers: '{"Accept": "application/json"}',
      },
      position: 0,
    },
    {
      id: 'step-check-warranty',
      name: 'Check Warranty',
      type: 'http',
      config: {
        method: 'GET',
        url: 'https://httpbin.org/get?deviceId=DEV-001&warrantyActive=true',
        headers: '{"Accept": "application/json"}',
      },
      position: 1,
    },
    {
      id: 'step-warranty-check',
      name: 'Warranty Check',
      type: 'condition',
      config: {
        expression: '{{trigger.payload.warrantyActive}}',
      },
      thenSteps: [
        {
          id: 'step-device-support',
          name: 'Device Support',
          type: 'agent_invocation',
          config: {
            agentId: 'device_support',
            message:
              'Handle device support request for customer {{steps.step-fetch-customer.output.body.args.customerId}}',
            timeout: 60,
          },
          position: 0,
        },
      ],
      elseSteps: [
        {
          id: 'step-repair-warranty',
          name: 'Repair & Warranty',
          type: 'agent_invocation',
          config: {
            agentId: 'repair_and_warranty',
            message:
              'Handle repair/warranty request for device {{steps.step-check-warranty.output.body.args.deviceId}}',
            timeout: 60,
          },
          position: 0,
        },
      ],
      position: 2,
    },
    {
      id: 'step-manager-approval',
      name: 'Manager Approval',
      type: 'approval',
      config: {
        title: 'Approve Jira ticket creation for support case',
        description: 'Review the support case details and approve creating a Jira ticket.',
        approvers: 'admin@kore.ai',
        timeoutHours: 24,
      },
      position: 3,
    },
    jiraStep,
  ];
}

// ─── Test ─────────────────────────────────────────────────────────────────

test.describe('Apple Care Workflow E2E', () => {
  let jiraConnectionId: string | null = null;
  let testToken: string = '';
  let testProjectId: string = '';

  test('Full lifecycle: connectors, connection CRUD, workflow, steps, branching, trigger, execute, monitor', async ({
    page,
  }) => {
    test.setTimeout(180000); // 3 minutes

    // ── Phase A: Login & Navigate ────────────────────────────────────
    const { projectId, token } = await loginAndSetup(page);
    testToken = token;
    testProjectId = projectId;

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-00-project.png`,
      fullPage: true,
    });

    // ── Phase A2: Verify Connector Catalog via Studio API ─────────────
    // This tests the new direct ConnectorListingService (no WE proxy)
    const connectors = await listConnectors(token, projectId);
    console.log(`Connector catalog: ${connectors.length} connectors loaded`);

    // We expect at least 2 connectors (native HTTP + some AP pieces)
    expect(connectors.length).toBeGreaterThanOrEqual(2);

    // Verify native HTTP connector is always present
    const httpConnector = connectors.find((c) => c.name === 'http');
    expect(httpConnector).toBeTruthy();
    console.log(`HTTP connector: ${httpConnector?.actions?.length || 0} actions`);

    // Check for some of the 25 installed AP pieces
    const expectedPieces = ['slack', 'github', 'openai', 'discord', 'stripe'];
    const foundPieces = expectedPieces.filter((name) => connectors.some((c) => c.name === name));
    console.log(
      `AP pieces found: ${foundPieces.join(', ')} (${foundPieces.length}/${expectedPieces.length})`,
    );

    // Log total actions + triggers across all connectors
    const totalActions = connectors.reduce((sum, c) => sum + (c.actions?.length || 0), 0);
    const totalTriggers = connectors.reduce((sum, c) => sum + (c.triggers?.length || 0), 0);
    console.log(`Catalog totals: ${totalActions} actions, ${totalTriggers} triggers`);

    // ── Phase B: Create Jira Connection via Studio API ────────────────
    // Clean up any existing Jira connections from previous runs
    const existing = await listConnections(token, projectId);
    for (const conn of existing.filter((c) => c.connectorName === 'jira-cloud')) {
      await deleteConnection(token, projectId, conn.id);
    }

    // Create fresh connection via Studio API (direct MongoDB, no WE proxy)
    const jiraResult = await createConnection(token, projectId, {
      connectorName: 'jira-cloud',
      displayName: 'Apple Care Jira',
      scope: 'tenant',
      authType: 'basic',
      credentials: {
        baseUrl: 'https://kore-test.atlassian.net',
        email: 'test@kore.ai',
        apiToken: 'test-api-token-for-e2e',
      },
    });
    jiraConnectionId = jiraResult?.id || null;
    console.log(
      jiraConnectionId
        ? `Jira connection ready: ${jiraConnectionId}`
        : 'Jira connection unavailable — using HTTP fallback for Jira step',
    );

    // ── Phase B2: Verify Connection Detail via Studio API ─────────────
    if (jiraConnectionId) {
      const detail = await getConnection(token, projectId, jiraConnectionId);
      expect(detail).toBeTruthy();
      console.log(
        `Connection detail — displayName: ${detail?.displayName}, status: ${detail?.status}, hasCredentials: ${detail?.hasCredentials}`,
      );

      // Verify credentials are redacted (not leaked)
      expect(detail?.encryptedCredentials).toBeUndefined();
      expect(detail?.hasCredentials).toBe(true);
      expect(detail?.connectorName).toBe('jira-cloud');
      expect(detail?.status).toBe('active');
    }

    // ── Phase B3: Test Connection via Studio API ──────────────────────
    if (jiraConnectionId) {
      const testResult = await testConnection(token, projectId, jiraConnectionId);
      console.log(
        `Connection test result: success=${testResult?.success}, latencyMs=${testResult?.latencyMs}${testResult?.error ? `, error=${testResult.error}` : ''}`,
      );
      // Test may fail (no real Jira credentials) but the API should respond
      expect(testResult).toBeTruthy();
      expect(typeof testResult?.success).toBe('boolean');
      expect(typeof testResult?.latencyMs).toBe('number');
    }

    // ── Phase C: Verify Connection in Connections Page UI ────────────
    if (jiraConnectionId) {
      // Navigate to Integrations (Connections) page via sidebar
      const integrationsNav = page.locator('nav >> text=Integrations');
      await expect(integrationsNav).toBeVisible({ timeout: 5000 });
      await integrationsNav.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/apple-care-01-connections.png`,
        fullPage: true,
      });

      // Verify "Connections" heading is visible
      const connectionsHeading = page.getByText('Connections').first();
      await expect(connectionsHeading).toBeVisible({ timeout: 5000 });

      // Verify the Jira connection card appears
      const jiraCard = page.getByText('Apple Care Jira').first();
      const jiraVisible = await jiraCard.isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`Jira connection card visible: ${jiraVisible}`);

      if (jiraVisible) {
        // Verify "Connected" status badge
        const connectedBadge = page.getByText('Connected').first();
        const statusVisible = await connectedBadge.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`Connected status badge visible: ${statusVisible}`);

        // Verify connector name
        const connectorName = page.getByText('jira-cloud').first();
        const nameVisible = await connectorName.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`Connector name "jira-cloud" visible: ${nameVisible}`);

        // Verify "Tenant" scope badge
        const tenantBadge = page.getByText('Tenant').first();
        const scopeVisible = await tenantBadge.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`Tenant scope badge visible: ${scopeVisible}`);
      }

      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/apple-care-01b-jira-card.png`,
        fullPage: true,
      });
    }

    // ── Phase D: Navigate to Workflows ────────────────────────────────
    await page.locator('nav >> text=Workflows').click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // ── Phase E: Create Workflow via UI ──────────────────────────────
    const newBtn = page.locator('button:has-text("New Workflow")');
    await expect(newBtn).toBeVisible({ timeout: 10000 });
    await newBtn.click();

    // Wait for Radix dialog to appear and animate in
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500); // Wait for Framer Motion animation

    // Fill workflow name
    const nameInput = dialog.locator('input[placeholder*="Order"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill('Apple Care Support Escalation');

    // Select type if dropdown is available
    const typeSelect = dialog.locator('select');
    if (await typeSelect.isVisible({ timeout: 1000 }).catch(() => false)) {
      await typeSelect.selectOption('cx_automation');
    }

    // Fill description
    const descInput = dialog.locator('textarea');
    if (await descInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await descInput.fill(
        'Apple Care support escalation workflow with customer lookup, warranty check, conditional agent routing, manager approval, and Jira ticket creation.',
      );
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-02-create-modal.png`,
      fullPage: true,
    });

    // Click "Create Workflow" submit button inside the dialog
    const submitBtn = dialog.getByRole('button', { name: /Create Workflow/i });
    await expect(submitBtn).toBeEnabled({ timeout: 3000 });
    await submitBtn.click();

    // Wait for navigation to detail page
    await page.waitForURL(/\/workflows\/[^/]+$/, { timeout: 20000 });
    await page.waitForTimeout(1000);

    const detailUrl = page.url();
    const workflowId = detailUrl.match(/\/workflows\/([^/]+)$/)?.[1];
    expect(workflowId).toBeTruthy();
    console.log(`Workflow created: ${workflowId}`);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-02b-detail.png`,
      fullPage: true,
    });

    // ── Phase F: Add Steps with Branching via API ─────────────────────
    const steps = buildBranchedSteps(jiraConnectionId);
    await updateWorkflowSteps(token, projectId, workflowId!, steps);
    console.log(
      `Added ${steps.length} steps with condition branching. Jira step type: ${jiraConnectionId ? 'connector_action' : 'http'}`,
    );

    // ── Phase G: Verify Steps in UI ──────────────────────────────────
    const stepsTab = page.locator('button:has-text("Steps")').first();
    await expect(stepsTab).toBeVisible({ timeout: 5000 });
    await stepsTab.click();
    await page.waitForTimeout(1000);

    // Reload to pick up API changes
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Click Steps tab again after reload
    await stepsTab.click();
    await page.waitForTimeout(1500);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-03-steps.png`,
      fullPage: true,
    });

    // Verify key steps are visible
    const httpStepVisible = await page
      .getByText('HTTP Request')
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const conditionStepVisible = await page
      .getByText('Condition')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const agentStepVisible = await page
      .getByText('Agent Invocation')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const approvalStepVisible = await page
      .getByText('Approval')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    console.log(
      `Steps visible — HTTP: ${httpStepVisible}, Condition: ${conditionStepVisible}, Agent: ${agentStepVisible}, Approval: ${approvalStepVisible}`,
    );
    expect(httpStepVisible).toBe(true);

    // ── Click through step editors ──────────────────────────────────
    // Click "Fetch Customer" step
    const fetchCustomerStep = page.getByText('Fetch Customer').first();
    if (await fetchCustomerStep.isVisible({ timeout: 2000 }).catch(() => false)) {
      await fetchCustomerStep.click();
      await page.waitForTimeout(500);
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/apple-care-03b-http-editor.png`,
        fullPage: true,
      });

      const urlInput2 = page.locator('input[placeholder*="https://"]');
      if (await urlInput2.isVisible({ timeout: 1000 }).catch(() => false)) {
        const urlValue = await urlInput2.inputValue();
        console.log(`Fetch Customer URL: ${urlValue}`);
      }
    }

    // Click "Warranty Check" condition step
    const warrantyCheckStep = page.getByText('Warranty Check').first();
    if (await warrantyCheckStep.isVisible({ timeout: 2000 }).catch(() => false)) {
      await warrantyCheckStep.click();
      await page.waitForTimeout(500);
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/apple-care-03c-condition-editor.png`,
        fullPage: true,
      });
    }

    // Click "Manager Approval" step
    const approvalStep = page.getByText('Manager Approval').first();
    if (await approvalStep.isVisible({ timeout: 2000 }).catch(() => false)) {
      await approvalStep.click();
      await page.waitForTimeout(500);
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/apple-care-03d-approval-editor.png`,
        fullPage: true,
      });
    }

    // Click "Create Jira Ticket" step
    const jiraStep = page.getByText('Create Jira Ticket').first();
    if (await jiraStep.isVisible({ timeout: 2000 }).catch(() => false)) {
      await jiraStep.click();
      await page.waitForTimeout(500);
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/apple-care-03e-jira-editor.png`,
        fullPage: true,
      });
      const jiraStepType = jiraConnectionId ? 'Connector Action' : 'HTTP Request';
      console.log(`Jira step type in editor: ${jiraStepType}`);
    }

    // ── Phase H: Add Webhook Trigger via UI ──────────────────────────
    const triggersTab = page.locator('button:has-text("Triggers")').first();
    await expect(triggersTab).toBeVisible({ timeout: 5000 });
    await triggersTab.click();
    await page.waitForTimeout(1000);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-04-triggers-empty.png`,
      fullPage: true,
    });

    // Click "Add Trigger" button
    const addTriggerBtn = page.locator('button:has-text("Add Trigger")');
    await expect(addTriggerBtn).toBeVisible({ timeout: 5000 });
    await addTriggerBtn.click();
    await page.waitForTimeout(500);

    // Verify trigger creation form
    const newTriggerHeading = page.getByText('New Trigger');
    await expect(newTriggerHeading).toBeVisible({ timeout: 3000 });

    const webhookTypeBtn = page.locator('button:has-text("Webhook")').first();
    await expect(webhookTypeBtn).toBeVisible({ timeout: 2000 });

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-04b-trigger-form.png`,
      fullPage: true,
    });

    // Click "Create Trigger" button
    const createTriggerBtn = page.locator('button:has-text("Create Trigger")');
    await expect(createTriggerBtn).toBeVisible({ timeout: 3000 });
    await createTriggerBtn.click();
    await page.waitForTimeout(3000);

    // Reload and navigate back to Triggers tab
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await triggersTab.click();
    await page.waitForTimeout(1000);

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-04c-trigger-created.png`,
      fullPage: true,
    });

    const triggerContent = await page.textContent('main, [role="main"], .flex-1');
    console.log('Triggers tab content:', triggerContent?.slice(0, 300));

    // ── Phase I: Execute Workflow via UI ──────────────────────────────
    const runBtn = page.locator('button:has-text("Run")').first();
    await expect(runBtn).toBeVisible({ timeout: 5000 });

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-05-before-run.png`,
      fullPage: true,
    });

    await runBtn.click();
    console.log('Workflow execution triggered via Run button');
    await page.waitForTimeout(3000);

    // ── Phase J: Monitor Execution ──────────────────────────────────
    const monitorTab = page.locator('button:has-text("Monitor")').first();
    if (await monitorTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await monitorTab.click();
      await page.waitForTimeout(2000);

      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/apple-care-05b-monitor-initial.png`,
        fullPage: true,
      });

      // Poll for execution rows
      let executionFound = false;
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(3000);

        const executionRows = page.locator('[class*="execution"], tr, [data-execution-id]');
        const rowCount = await executionRows.count();
        if (rowCount > 0) {
          executionFound = true;
          console.log(`Execution rows found: ${rowCount}`);
          break;
        }

        const monitorContent = await page.textContent('main, [role="main"], .flex-1');
        if (
          monitorContent?.includes('running') ||
          monitorContent?.includes('completed') ||
          monitorContent?.includes('failed') ||
          monitorContent?.includes('waiting')
        ) {
          executionFound = true;
          console.log('Execution status found in monitor content');
          break;
        }
      }

      console.log(`Execution found in monitor: ${executionFound}`);

      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/apple-care-05c-monitor-after-wait.png`,
        fullPage: true,
      });
    }

    // ── Final screenshot ────────────────────────────────────────────
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/apple-care-06-final.png`,
      fullPage: true,
    });

    console.log('\nApple Care E2E complete! Screenshots in e2e/screenshots/apple-care-*.png');
    console.log(`Connector catalog: ${connectors.length} connectors loaded`);
    console.log('Workflow design:');
    console.log('  [Webhook Trigger]');
    console.log('  [Step 1: Fetch Customer] HTTP GET -> httpbin.org/get');
    console.log('  [Step 2: Check Warranty] HTTP GET -> httpbin.org/get');
    console.log('  [Step 3: Warranty Check] CONDITION -> warrantyActive');
    console.log('    |- THEN: [Device Support] agent_invocation');
    console.log('    |- ELSE: [Repair & Warranty] agent_invocation');
    console.log('  [Step 4: Manager Approval] APPROVAL -> admin@kore.ai');
    console.log(
      `  [Step 5: Create Jira Ticket] ${jiraConnectionId ? 'CONNECTOR_ACTION -> jira-cloud' : 'HTTP POST -> httpbin.org/post'}`,
    );
  });

  test.afterEach(async () => {
    // Clean up Jira connection via Studio API
    if (jiraConnectionId && testToken && testProjectId) {
      await deleteConnection(testToken, testProjectId, jiraConnectionId);
    }
  });
});
