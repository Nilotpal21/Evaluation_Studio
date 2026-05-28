import { z } from 'zod';
import type { SmartAssistClient } from '../adapters/kore/smartassist-client.js';
import type { OperationResult } from '../types.js';

export const CheckAvailabilityInputSchema = z.object({
  agentId: z.string().min(1),
  contactId: z.string().min(1),
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  skills: z.array(z.string()).optional(),
  queue: z.string().optional(),
  language: z.string().optional(),
});

export type CheckAvailabilityInput = z.infer<typeof CheckAvailabilityInputSchema>;

export class CheckAvailabilityTool {
  private readonly client: SmartAssistClient;
  constructor(client: SmartAssistClient) {
    this.client = client;
  }

  async execute(input: CheckAvailabilityInput): Promise<OperationResult<boolean>> {
    const parsed = CheckAvailabilityInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      };
    }
    return this.client.checkAgentAvailability({
      agentId: parsed.data.agentId,
      contactId: parsed.data.contactId,
      tenantId: parsed.data.tenantId,
      projectId: parsed.data.projectId,
      skills: parsed.data.skills,
      queue: parsed.data.queue,
      language: parsed.data.language,
    });
  }
}
