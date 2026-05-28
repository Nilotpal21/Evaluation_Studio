import type { PageContext } from '@agent-platform/arch-ai';

const DEICTIC_REFERENCE_PATTERN = /\b(this|that|it|these|those|here|current|selected)\b/i;
const ANALYSIS_INTENT_PATTERN =
  /\b(analy[sz]e|analysis|review|debug|diagnos(?:e|is)|inspect|investigate|improve|optimi[sz]e|performance|quality|containment|trace|traces|session|sessions|conversation|conversations|what\s+went\s+wrong|why)\b/i;

const EXPLICIT_TARGET_PATTERN =
  /\b(session|trace|run|agent|tool|workflow|knowledge\s*base|kb|connector|connection|server|pipeline|page|tab|section|guardrail|settings?)\b/i;

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function describePageFocus(pageContext: PageContext | null | undefined): string | null {
  if (!pageContext) {
    return null;
  }

  const entity = pageContext.entity;
  const entityLabel = entity
    ? `${entity.type} "${entity.name ?? entity.id}"`
    : `${pageContext.page} page`;
  const tabLabel = pageContext.tab ? ` on tab "${pageContext.tab}"` : '';
  const sectionLabel = pageContext.subSection ? ` in section "${pageContext.subSection}"` : '';

  return `${entityLabel}${tabLabel}${sectionLabel}`;
}

function getPageContextCapabilities(pageContext: PageContext | null | undefined): Set<string> {
  return new Set(
    (pageContext?.capabilities ?? []).map((capability) => capability.trim().toLowerCase()),
  );
}

function isProductionOptimizationPage(pageContext: PageContext | null | undefined): boolean {
  if (!pageContext) {
    return false;
  }

  const page = normalize(pageContext.page);
  const capabilities = getPageContextCapabilities(pageContext);

  return (
    page === 'sessions' ||
    page === 'analytics' ||
    page === 'dashboard' ||
    page === 'agent-performance' ||
    page === 'quality-monitor' ||
    page === 'customer-insights' ||
    page === 'voice-analytics' ||
    capabilities.has('production_agent_optimization') ||
    capabilities.has('session_observability') ||
    capabilities.has('trace_diagnostics') ||
    capabilities.has('quality_monitoring')
  );
}

function isSessionDetailContext(pageContext: PageContext | null | undefined): boolean {
  return (
    normalize(pageContext?.entity?.type) === 'session' &&
    normalize(pageContext?.entity?.id) !== null
  );
}

function isSessionOrAnalyticsListContext(pageContext: PageContext | null | undefined): boolean {
  if (!pageContext || isSessionDetailContext(pageContext)) {
    return false;
  }

  const page = normalize(pageContext.page);
  const capabilities = getPageContextCapabilities(pageContext);

  return (
    page === 'sessions' ||
    page === 'analytics' ||
    page === 'dashboard' ||
    page === 'agent-performance' ||
    page === 'quality-monitor' ||
    page === 'customer-insights' ||
    page === 'voice-analytics' ||
    capabilities.has('session_analytics') ||
    capabilities.has('analytics') ||
    capabilities.has('quality_monitoring')
  );
}

function isPageAnalysisRequest(text: string): boolean {
  return ANALYSIS_INTENT_PATTERN.test(text.trim());
}

function hasExplicitSessionIdentifier(text: string): boolean {
  return /\b(?:s-|s_|sdk_)[a-z0-9][a-z0-9_-]{5,}\b/i.test(text);
}

function hasExplicitAggregateScope(text: string): boolean {
  return /\b(all|every|each|visible|filtered|current\s+(?:page|list|table))\s+(?:sessions?|traces?|conversations?)\b/i.test(
    text,
  );
}

function shouldProtectPendingAction(
  previousPageContext: PageContext | null | undefined,
  currentPageContext: PageContext | null | undefined,
): boolean {
  return (
    isProductionOptimizationPage(currentPageContext) &&
    (!previousPageContext || hasMaterialPageContextChange(previousPageContext, currentPageContext))
  );
}

export function isAmbiguousPageReference(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !DEICTIC_REFERENCE_PATTERN.test(trimmed)) {
    return false;
  }

  if (EXPLICIT_TARGET_PATTERN.test(trimmed)) {
    return false;
  }

  return trimmed.length <= 160;
}

export function hasMaterialPageContextChange(
  previousPageContext: PageContext | null | undefined,
  currentPageContext: PageContext | null | undefined,
): boolean {
  if (!previousPageContext || !currentPageContext) {
    return false;
  }

  return (
    normalize(previousPageContext.page) !== normalize(currentPageContext.page) ||
    normalize(previousPageContext.entity?.type) !== normalize(currentPageContext.entity?.type) ||
    normalize(previousPageContext.entity?.id) !== normalize(currentPageContext.entity?.id) ||
    normalize(previousPageContext.tab) !== normalize(currentPageContext.tab) ||
    normalize(previousPageContext.subSection) !== normalize(currentPageContext.subSection)
  );
}

export function shouldClarifyPageContextIntent(params: {
  text: string;
  previousPageContext: PageContext | null | undefined;
  currentPageContext: PageContext | null | undefined;
  hasPendingAction?: boolean;
}): boolean {
  const isAnalysisRequest = isPageAnalysisRequest(params.text);

  if (
    params.hasPendingAction === true &&
    isAnalysisRequest &&
    shouldProtectPendingAction(params.previousPageContext, params.currentPageContext)
  ) {
    return true;
  }

  if (isAnalysisRequest && isSessionOrAnalyticsListContext(params.currentPageContext)) {
    const text = params.text.trim();
    if (
      !hasExplicitSessionIdentifier(text) &&
      !hasExplicitAggregateScope(text) &&
      /\b(session|sessions|trace|traces|conversation|conversations|this|these|current|selected|page|list|table)\b/i.test(
        text,
      )
    ) {
      return true;
    }
  }

  return (
    isAmbiguousPageReference(params.text) &&
    hasMaterialPageContextChange(params.previousPageContext, params.currentPageContext)
  );
}

export function buildPageContextClarificationAppendix(params: {
  previousPageContext: PageContext | null | undefined;
  currentPageContext: PageContext | null | undefined;
  hasPendingAction?: boolean;
}): string {
  const previousFocus = describePageFocus(params.previousPageContext) ?? 'the earlier page focus';
  const currentFocus = describePageFocus(params.currentPageContext) ?? 'the current page focus';

  if (
    params.hasPendingAction === true &&
    shouldProtectPendingAction(params.previousPageContext, params.currentPageContext)
  ) {
    return [
      'The user appears to be switching from an existing Arch task to the current production analytics/session page while there is still a pending Arch action or proposal.',
      `Previous focus: ${previousFocus}.`,
      `Current focus: ${currentFocus}.`,
      'Do not discard or override the pending action implicitly.',
      'Use ask_user to ask one short confirmation question: continue the pending Arch action, or switch to analyzing the current page context?',
    ].join('\n');
  }

  if (isSessionOrAnalyticsListContext(params.currentPageContext)) {
    return [
      'The user is asking for analysis from a production analytics/session list page, but no single session is selected in the page context.',
      `Current focus: ${currentFocus}.`,
      'Do not assume they mean every session because that can exceed tool limits.',
      'Use ask_user to ask exactly one short scope question: analyze all visible/filtered sessions, a focused sample of the highest-risk sessions, or a specific session ID?',
    ].join('\n');
  }

  return [
    'The user changed page context during this conversation and their latest message uses an ambiguous reference such as "this", "that", or "it".',
    `Previous focus: ${previousFocus}.`,
    `Current focus: ${currentFocus}.`,
    'Do not assume which target they mean.',
    'Use ask_user to ask exactly one short clarification question that contrasts the previous focus with the current focus, then wait for the answer.',
  ].join('\n');
}
