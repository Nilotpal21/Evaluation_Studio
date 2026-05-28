import type {
  SessionListItem,
  SessionTreeEvent,
  SparklinePoint,
} from '@/lib/arch-inspector-reader';

export type { SessionListItem, SessionTreeEvent, SparklinePoint };

export interface TreeNode {
  event: SessionTreeEvent;
  children: TreeNode[];
  expanded: boolean;
}

export interface SessionTree {
  phases: TreeNode[];
  legacyEvents: SessionTreeEvent[];
}

export interface NodePayload {
  eventId: string;
  payloadType: string;
  content: string;
}

export type InspectorView = 'list' | 'tree';

export interface SessionFilters {
  projectId?: string;
  userId?: string;
  from?: string;
  to?: string;
  hasErrors?: boolean;
  minCost?: number;
}
