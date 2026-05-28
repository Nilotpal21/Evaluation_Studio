import { z } from 'zod';
import type { SmartAssistClient } from '../adapters/kore/smartassist-client.js';
import type { OperationResult } from '../types.js';

export const CheckHoursInputSchema = z.object({
  agentId: z.string().min(1),
  hoursId: z.string().min(1),
});

export type CheckHoursInput = z.infer<typeof CheckHoursInputSchema>;

export class CheckHoursTool {
  private readonly client: SmartAssistClient;
  constructor(client: SmartAssistClient) {
    this.client = client;
  }

  async execute(input: CheckHoursInput): Promise<OperationResult<boolean>> {
    const parsed = CheckHoursInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      };
    }
    return this.client.checkBusinessHours(parsed.data.hoursId);
  }
}
