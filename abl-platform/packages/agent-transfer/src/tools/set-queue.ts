import { z } from 'zod';
import type { SmartAssistClient } from '../adapters/kore/smartassist-client.js';
import type { OperationResult } from '../types.js';

export const SetQueueInputSchema = z.object({
  agentId: z.string().min(1),
  queueId: z.string().min(1),
});

export type SetQueueInput = z.infer<typeof SetQueueInputSchema>;

export class SetQueueTool {
  private readonly client: SmartAssistClient;
  constructor(client: SmartAssistClient) {
    this.client = client;
  }

  async execute(input: SetQueueInput): Promise<OperationResult<boolean>> {
    const parsed = SetQueueInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      };
    }
    return this.client.validateQueue(parsed.data.queueId);
  }
}
