/**
 * Plan Feature Defaults
 *
 * Single source of truth for which features are included in each subscription
 * tier. Consumed by:
 *   - Runtime feature-gate middleware (apps/runtime/src/middleware/feature-gate.ts)
 *   - Studio features API route (apps/studio/src/app/api/features/route.ts)
 *   - Runtime platform-admin features route
 *   - Runtime workspace-billing route
 *
 * Add-on flags such as `governance` are intentionally omitted from every
 * default plan and must be granted through tenant entitlements or active deals.
 */

export const PLAN_FEATURES: Record<string, string[]> = {
  FREE: ['guardrails', 'voice_channels'],
  TEAM: ['advanced_analytics', 'guardrails', 'connectors', 'voice_channels'],
  BUSINESS: [
    'advanced_analytics',
    'guardrails',
    'connectors',
    'voice_channels',
    'custom_models',
    'audit_export',
    'sso',
    'reusable_modules',
    'omnichannel_session_continuity',
  ],
  ENTERPRISE: [
    'advanced_analytics',
    'guardrails',
    'connectors',
    'custom_models',
    'audit_export',
    'sso',
    'kms_byok',
    'advanced_nlu',
    'voice_channels',
    'reusable_modules',
    'omnichannel_session_continuity',
  ],
};
