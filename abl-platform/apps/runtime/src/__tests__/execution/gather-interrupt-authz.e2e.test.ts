import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { requestJson, setSuperAdmins } from '../helpers/channel-e2e-bootstrap.js';
import {
  bootstrapGatherInterruptContext,
  GATHER_INTERRUPT_MESSAGE,
  sendGatherInterrupt,
  startChildGatherConversation,
  startGatherInterruptTestHarness,
  type GatherInterruptCombinedHarness,
} from '../helpers/gather-interrupt-harness.js';

const SUITE_TIMEOUT_MS = 120_000;

describe.sequential('Gather interrupt chat authz E2E', () => {
  let combined: GatherInterruptCombinedHarness;

  beforeAll(async () => {
    combined = await startGatherInterruptTestHarness();
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    await combined.reset();
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await combined.close();
  }, SUITE_TIMEOUT_MS);

  test('allows the owning tenant and project to resume a child gather session through /api/v1/chat/agent', async () => {
    const context = await bootstrapGatherInterruptContext(combined);
    await setSuperAdmins([]);
    clearPermissionCache();

    const firstTurn = await startChildGatherConversation(context);
    expect(firstTurn.status).toBe(200);

    const secondTurn = await sendGatherInterrupt(
      context,
      firstTurn.body.sessionId,
      GATHER_INTERRUPT_MESSAGE,
    );

    expect(secondTurn.status).toBe(200);
    expect(secondTurn.body.sessionId).toBe(firstTurn.body.sessionId);
    expect(secondTurn.body.action).toMatchObject({
      type: 'handoff',
      target: 'BranchLocatorSibling',
    });
  });

  test('returns 401 when the Authorization header is missing on a resumed child gather turn', async () => {
    const context = await bootstrapGatherInterruptContext(combined);
    await setSuperAdmins([]);
    clearPermissionCache();

    const firstTurn = await startChildGatherConversation(context);
    expect(firstTurn.status).toBe(200);

    const unauthorizedTurn = await requestJson<{ error?: string }>(
      context.harness,
      '/api/v1/chat/agent',
      {
        method: 'POST',
        body: {
          projectId: context.admin.projectId,
          sessionId: firstTurn.body.sessionId,
          message: GATHER_INTERRUPT_MESSAGE,
        },
      },
    );

    expect(unauthorizedTurn.status).toBe(401);
    expect(unauthorizedTurn.body.error).toBeDefined();
  });

  test('returns 404 for cross-project and cross-tenant resumed child-gather turns without leaking route availability', async () => {
    const context = await bootstrapGatherInterruptContext(combined);
    await setSuperAdmins([]);
    clearPermissionCache();

    const firstTurn = await startChildGatherConversation(context);
    expect(firstTurn.status).toBe(200);

    const crossProjectTurn = await requestJson<{ error?: string }>(
      context.harness,
      '/api/v1/chat/agent',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${context.admin.token}`,
        },
        body: {
          projectId: context.alternateProjectId,
          sessionId: firstTurn.body.sessionId,
          message: GATHER_INTERRUPT_MESSAGE,
        },
      },
    );

    expect(crossProjectTurn.status).toBe(404);
    expect(crossProjectTurn.body.error).toBe('Session not found');

    const crossTenantTurn = await requestJson<{ error?: string }>(
      context.harness,
      '/api/v1/chat/agent',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${context.outsider.token}`,
        },
        body: {
          projectId: context.outsider.projectId,
          sessionId: firstTurn.body.sessionId,
          message: GATHER_INTERRUPT_MESSAGE,
        },
      },
    );

    expect(crossTenantTurn.status).toBe(404);
    expect(crossTenantTurn.body.error).toBe('Session not found');
  });
});
