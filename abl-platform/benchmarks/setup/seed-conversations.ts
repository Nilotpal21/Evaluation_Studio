import http from 'k6/http';
import { sleep } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import { httpWithRetry } from './helpers.ts';

const SEED_CONVERSATION_COUNT = 5;

export interface SeedResult {
  conversationCount: number;
  sessionIds: string[];
}

export function seedConversations(
  accessToken: string,
  projectId: string,
  overrideRuntimeUrl?: string,
): SeedResult {
  const runtimeUrl = overrideRuntimeUrl || config.runtimeUrl;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Accept: 'text/event-stream',
    Origin: config.studioUrl,
    'X-Tenant-Id': config.tenantId,
  };

  const sessionIds: string[] = [];

  for (let c = 0; c < SEED_CONVERSATION_COUNT; c++) {
    const res = httpWithRetry(
      'POST',
      `${runtimeUrl}${apiPath('/v1/chat/stream')}`,
      JSON.stringify({
        projectId,
        messages: [
          {
            role: 'user',
            content: `Seed conversation ${c + 1}: What is ${c + 1} + ${c + 2}?`,
          },
        ],
      }),
      headers,
      { label: `seed-conversation-${c}` },
    );

    if (res.status === 200) {
      const body = res.body as string;
      const hasComplete = body.includes('event: complete');
      if (hasComplete) {
        // Use X-Request-Id as conversation identifier (sessionId not returned by this endpoint)
        const requestId = (res.headers['X-Request-Id'] ||
          res.headers['x-request-id'] ||
          `seed-${c + 1}`) as string;
        sessionIds.push(requestId);
        console.log(`[seed-conversations] Created conversation ${c + 1} (requestId: ${requestId})`);
      } else {
        console.warn(
          `[seed-conversations] Conversation ${c + 1} returned 200 but no complete event`,
        );
      }
    } else {
      console.warn(
        `[seed-conversations] Failed conversation ${c + 1}: ${res.status} ${((res.body as string) || '').substring(0, 200)}`,
      );
    }

    sleep(1);
  }

  console.log(
    `[seed-conversations] Seeded ${sessionIds.length}/${SEED_CONVERSATION_COUNT} conversations`,
  );

  return {
    conversationCount: sessionIds.length,
    sessionIds,
  };
}
