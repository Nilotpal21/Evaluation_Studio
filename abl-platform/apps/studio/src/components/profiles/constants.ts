import type { BadgeVariant } from '../ui/Badge';

export const NEW_BEHAVIOR_PROFILE_ROUTE_SEGMENT = '__new__';

export const CATEGORY_VARIANTS: Record<string, BadgeVariant> = {
  conversation: 'accent',
  instructions: 'accent',
  flow: 'purple',
  tools: 'success',
  constraints: 'warning',
  voice: 'info',
  gather: 'default',
  response_rules: 'info',
};

export function getCategoryVariant(category: string): BadgeVariant {
  return CATEGORY_VARIANTS[category] ?? 'default';
}
