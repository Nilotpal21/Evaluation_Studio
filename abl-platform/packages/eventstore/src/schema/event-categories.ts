/**
 * Event category constants and mappings.
 *
 * Categories are used for:
 * - ClickHouse ORDER BY clause (tenant_id, category, event_type, timestamp)
 * - Query filtering (category='llm' to get all LLM events)
 * - UI grouping in Studio dashboards
 */

import type { EventCategory } from '../interfaces/types.js';

export const EVENT_CATEGORIES = {
  BILLING: 'billing',
  SESSION: 'session',
  MESSAGE: 'message',
  ATTACHMENT: 'attachment',
  LLM: 'llm',
  TOOL: 'tool',
  AGENT: 'agent',
  GATHER: 'gather',
  FLOW: 'flow',
  CHANNEL: 'channel',
  DEPLOYMENT: 'deployment',
  SEARCH: 'search',
  VOICE: 'voice',
  AUDIT: 'audit',
  EVALUATION: 'evaluation',
  FEEDBACK: 'feedback',
  SYSTEM: 'system',
} as const;

/**
 * Map event_type prefix to category.
 * Used to infer category from event_type during emit.
 */
export function getCategoryFromEventType(eventType: string): EventCategory {
  const prefix = eventType.split('.')[0];

  switch (prefix) {
    case 'billing':
      return EVENT_CATEGORIES.BILLING;
    case 'session':
      return EVENT_CATEGORIES.SESSION;
    case 'message':
      return EVENT_CATEGORIES.MESSAGE;
    case 'attachment':
      return EVENT_CATEGORIES.ATTACHMENT;
    case 'llm':
      return EVENT_CATEGORIES.LLM;
    case 'tool':
      return EVENT_CATEGORIES.TOOL;
    case 'agent':
      return EVENT_CATEGORIES.AGENT;
    case 'gather':
      return EVENT_CATEGORIES.GATHER;
    case 'flow':
      return EVENT_CATEGORIES.FLOW;
    case 'channel':
      return EVENT_CATEGORIES.CHANNEL;
    case 'deployment':
      return EVENT_CATEGORIES.DEPLOYMENT;
    case 'search':
      return EVENT_CATEGORIES.SEARCH;
    case 'voice':
      return EVENT_CATEGORIES.VOICE;
    case 'auth':
    case 'audit':
      return EVENT_CATEGORIES.AUDIT;
    case 'evaluation':
      return EVENT_CATEGORIES.EVALUATION;
    case 'feedback':
      return EVENT_CATEGORIES.FEEDBACK;
    default:
      return EVENT_CATEGORIES.SYSTEM;
  }
}

/**
 * Get display label for category (for UI).
 */
export function getCategoryLabel(category: EventCategory): string {
  const labels: Record<EventCategory, string> = {
    billing: 'Billing',
    session: 'Sessions',
    message: 'Messages',
    attachment: 'Attachments',
    llm: 'LLM Calls',
    tool: 'Tool Calls',
    agent: 'Agent Routing',
    gather: 'Data Collection',
    flow: 'Flow Execution',
    channel: 'Channels',
    deployment: 'Deployments',
    search: 'Search',
    voice: 'Voice',
    audit: 'Audit & Auth',
    evaluation: 'Evaluations',
    feedback: 'Feedback',
    system: 'System',
  };
  return labels[category] || category;
}
