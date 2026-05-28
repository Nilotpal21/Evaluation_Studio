// =============================================================================
// @agent-platform/design-tokens — Public API
// =============================================================================

// Core intent system
export type { SemanticIntent, IntentStyles, BadgeIntentStyles } from './intents';
export { getIntentStyles, getBadgeIntentStyles, intentClass } from './intents';

// Domain → intent mappings
export {
  statusIntent,
  traceEventIntent,
  pipelineStageIntent,
  pipelineNodeIntent,
  featureTierIntent,
  severityIntent,
  trendIntent,
  connectorIntent,
} from './color-maps';

// Chart color utilities
export {
  SEMANTIC_CHART_COLORS,
  CHART_COLOR_PALETTE,
  NAMESPACE_COLOR_TOKENS,
  isNamespaceColorToken,
  resolveNamespaceColor,
  resolveTokenColor,
  resolveAllChartColors,
  useChartColors,
} from './chart-colors';
export type { NamespaceColorToken } from './chart-colors';

// Overlay constants
export { OVERLAY_BACKDROP, OVERLAY_BACKDROP_LIGHT, OVERLAY_BG } from './overlay';

// Gradient tokens
export type { GradientToken, GradientCategory, GradientStyles } from './gradients';
export { getGradientStyles, getGradientValue, GRADIENT_TOKENS } from './gradients';
