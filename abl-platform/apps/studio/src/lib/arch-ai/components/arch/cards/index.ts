export { KBStatusCard } from './KBStatusCard';
export { SearchResultsCard } from './SearchResultsCard';
export { KBHealthCard } from './KBHealthCard';
export { ConnectorStatusCard } from './ConnectorStatusCard';
export { UploadProgressCard } from './UploadProgressCard';
export { DocProcessingCard } from './DocProcessingCard';
export { ExternalAgentCard } from './ExternalAgentCard';
export {
  IntegrationSuggestionCard,
  type IntegrationSuggestionPayload,
} from './IntegrationSuggestionCard';

import type { ComponentType } from 'react';
import { KBStatusCard } from './KBStatusCard';
import { SearchResultsCard } from './SearchResultsCard';
import { KBHealthCard } from './KBHealthCard';
import { ConnectorStatusCard } from './ConnectorStatusCard';
import { UploadProgressCard } from './UploadProgressCard';
import { DocProcessingCard } from './DocProcessingCard';
import { ExternalAgentCard } from './ExternalAgentCard';
import { IntegrationSuggestionCard } from './IntegrationSuggestionCard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const KB_CARD_MAP: Record<string, ComponentType<{ event: any }>> = {
  kb_status_card: KBStatusCard,
  upload_progress_card: UploadProgressCard,
  search_results_card: SearchResultsCard,
  kb_health_card: KBHealthCard,
  connector_status_card: ConnectorStatusCard,
  doc_processing_card: DocProcessingCard,
  external_agent_card: ExternalAgentCard,
  integration_suggestion_card: IntegrationSuggestionCard,
};

export function isKBCardEvent(type: string): boolean {
  return type in KB_CARD_MAP;
}
