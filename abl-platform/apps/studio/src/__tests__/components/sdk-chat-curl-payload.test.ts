/**
 * SDK API curl example payload — metadata + interactionContext contract
 *
 * Locks the curl example shown in the SDK API channel OverviewTab. The
 * helper surfaces `metadata` and `interactionContext` placeholders so
 * customers copying the snippet immediately see those fields and know
 * to populate them (ABLP-1019 follow-up). Tests the pure extracted
 * builder directly — no React, no mocks.
 */

import { describe, test, expect } from 'vitest';
import { buildSdkChatExamplePayload } from '../../components/deployments/channels/sdk-chat-curl.js';

describe('buildSdkChatExamplePayload — SDK API curl example', () => {
  const payload = buildSdkChatExamplePayload({
    projectId: 'project-abc',
    deploymentId: 'dep-1',
  });

  test('includes a metadata placeholder so users discover the field', () => {
    expect(payload).toHaveProperty('metadata');
    const meta = payload.metadata as Record<string, string>;
    expect(meta).toHaveProperty('customerId');
    expect(meta).toHaveProperty('source');
  });

  test('includes an interactionContext placeholder with locale + timezone', () => {
    expect(payload).toHaveProperty('interactionContext');
    const ctx = payload.interactionContext as Record<string, string>;
    expect(ctx).toHaveProperty('locale');
    expect(ctx).toHaveProperty('timezone');
  });
});
