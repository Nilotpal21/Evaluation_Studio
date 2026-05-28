/**
 * Shared types for error state components.
 */

import type { ConnectorTab } from '../../../../store/connector-store';
import type { ConnectorErrorData } from './ConnectorErrorState';

export interface ErrorComponentProps {
  error: ConnectorErrorData;
  connectorId: string;
  indexId: string;
  onRetry: (action: string) => void;
  onNavigateToTab: (tab: ConnectorTab) => void;
  onReAuth: () => void;
}
