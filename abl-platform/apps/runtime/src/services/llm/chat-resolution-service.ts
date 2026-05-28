import { isTenantEncryptionReady } from '@agent-platform/shared/encryption';
import { ModelResolutionService } from './model-resolution.js';
import { isResolutionDatabaseAvailable } from '../../repos/llm-resolution-repo.js';

let chatResolutionService: ModelResolutionService | null = null;

export function getChatResolutionService(): ModelResolutionService {
  if (!chatResolutionService) {
    chatResolutionService = new ModelResolutionService(
      isResolutionDatabaseAvailable(),
      isTenantEncryptionReady,
    );
  }

  return chatResolutionService;
}

export function clearChatResolutionCache(tenantId?: string): void {
  chatResolutionService?.clearCache(tenantId);
}
