import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  createSdkBootstrapChannel,
  createSdkPublicKey,
  initSdkSession,
  requestJson,
  sdkHeaders,
  setSuperAdmins,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  bootstrapGatherInterruptContext,
  GATHER_INTERRUPT_MESSAGE,
  INITIAL_CHILD_HANDOFF_TRIGGER,
  startGatherInterruptTestHarness,
  type GatherInterruptChatResponse,
  type GatherInterruptCombinedHarness,
  type GatherInterruptContext,
} from '../helpers/gather-interrupt-harness.js';

const SUITE_TIMEOUT_MS = 120_000;

async function startChildGatherConversationViaSdk(
  context: GatherInterruptContext,
  sdkToken: string,
  message = INITIAL_CHILD_HANDOFF_TRIGGER,
) {
  return requestJson<GatherInterruptChatResponse>(context.harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: sdkHeaders(sdkToken),
    body: {
      projectId: context.admin.projectId,
      agentId: 'GatherInterruptSupervisor',
      message,
    },
  });
}

async function sendGatherInterruptViaSdk(
  context: GatherInterruptContext,
  sdkToken: string,
  sessionId: string,
  message = GATHER_INTERRUPT_MESSAGE,
) {
  return requestJson<GatherInterruptChatResponse & { error?: string }>(
    context.harness,
    '/api/v1/chat/agent',
    {
      method: 'POST',
      headers: sdkHeaders(sdkToken),
      body: {
        projectId: context.admin.projectId,
        sessionId,
        message,
      },
    },
  );
}

describe.sequential('Gather interrupt SDK chat E2E', () => {
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

  test(
    'preserves gather interrupt rerouting for SDK chat and rejects resumed child-gather reuse by another SDK user',
    async () => {
      const context = await bootstrapGatherInterruptContext(combined);

      const publicKey = await createSdkPublicKey(
        context.harness,
        context.admin.token,
        context.admin.projectId,
        {
          name: 'Gather Interrupt SDK Key',
        },
      );
      await createSdkBootstrapChannel(
        context.harness,
        context.admin.token,
        context.admin.projectId,
        publicKey.id,
      );

      await setSuperAdmins([]);
      clearPermissionCache();

      const owningSdkSession = await initSdkSession(context.harness, {
        publicKey: publicKey.key!,
        userContext: { userId: 'gather-sdk-owner' },
      });
      const outsiderSdkSession = await initSdkSession(context.harness, {
        publicKey: publicKey.key!,
        userContext: { userId: 'gather-sdk-outsider' },
      });

      const firstTurn = await startChildGatherConversationViaSdk(context, owningSdkSession.token);

      expect(firstTurn.status).toBe(200);
      expect(firstTurn.body.sessionId).toBeTruthy();
      expect(firstTurn.body.response.toLowerCase()).toContain('destination');

      const hijackTurn = await sendGatherInterruptViaSdk(
        context,
        outsiderSdkSession.token,
        firstTurn.body.sessionId,
      );

      expect(hijackTurn.status).toBe(404);
      expect(hijackTurn.body.error).toBe('Session not found');

      const secondTurn = await sendGatherInterruptViaSdk(
        context,
        owningSdkSession.token,
        firstTurn.body.sessionId,
      );

      expect(secondTurn.status).toBe(200);
      expect(secondTurn.body.sessionId).toBe(firstTurn.body.sessionId);
      expect(secondTurn.body.response).toContain('find branches nearby');
      expect(secondTurn.body.action).toMatchObject({
        type: 'handoff',
        target: 'BranchLocatorSibling',
      });
      expect(secondTurn.body.traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'digression',
            data: expect.objectContaining({
              intent: 'branch_locator',
              detectionMode: 'lexical',
              lexicalMatchType: 'normalized',
              matched: 'branch',
              target: 'BranchLocatorSibling',
            }),
          }),
          expect.objectContaining({
            type: 'return_to_parent',
            data: expect.objectContaining({
              from: 'ChildGatherFlow',
              to: 'GatherInterruptSupervisor',
              forwardedMessage: GATHER_INTERRUPT_MESSAGE,
            }),
          }),
        ]),
      );
    },
    SUITE_TIMEOUT_MS,
  );
});
