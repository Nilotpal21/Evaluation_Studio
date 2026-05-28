import { describe, expect, it } from 'vitest';

import {
  buildPageContextClarificationAppendix,
  hasMaterialPageContextChange,
  isAmbiguousPageReference,
  shouldClarifyPageContextIntent,
} from '../../lib/arch-ai/page-context-ambiguity';

describe('page-context ambiguity helpers', () => {
  it('detects ambiguous deictic references', () => {
    expect(isAmbiguousPageReference('fix this')).toBe(true);
    expect(isAmbiguousPageReference('debug it')).toBe(true);
  });

  it('does not flag explicit targets as ambiguous', () => {
    expect(isAmbiguousPageReference('fix this session')).toBe(false);
    expect(isAmbiguousPageReference('review this tool')).toBe(false);
  });

  it('treats entity and nested view changes as material', () => {
    expect(
      hasMaterialPageContextChange(
        {
          area: 'project',
          page: 'agents',
          entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
          tab: 'config',
          subSection: 'guardrails',
        },
        {
          area: 'project',
          page: 'tools',
          entity: { type: 'tool', id: 'tool-123', name: 'tool-123' },
          tab: 'testing',
        },
      ),
    ).toBe(true);

    expect(
      hasMaterialPageContextChange(
        {
          area: 'project',
          page: 'agents',
          entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
          tab: 'config',
        },
        {
          area: 'project',
          page: 'agents',
          entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
          tab: 'chat',
        },
      ),
    ).toBe(true);
  });

  it('requests clarification only when the user switched context and stayed vague', () => {
    expect(
      shouldClarifyPageContextIntent({
        text: 'fix this',
        previousPageContext: {
          area: 'project',
          page: 'agents',
          entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
        },
        currentPageContext: {
          area: 'project',
          page: 'sessions',
          entity: { type: 'session', id: 'sess-123', name: 'sess-123' },
        },
      }),
    ).toBe(true);

    expect(
      shouldClarifyPageContextIntent({
        text: 'fix this session',
        previousPageContext: {
          area: 'project',
          page: 'agents',
          entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
        },
        currentPageContext: {
          area: 'project',
          page: 'sessions',
          entity: { type: 'session', id: 'sess-123', name: 'sess-123' },
        },
      }),
    ).toBe(false);
  });

  it('asks for scope on session list analysis requests but not on an opened session', () => {
    expect(
      shouldClarifyPageContextIntent({
        text: 'analyse my session',
        previousPageContext: undefined,
        currentPageContext: {
          area: 'project',
          page: 'sessions',
          tab: 'conversations',
          capabilities: [
            'production_agent_optimization',
            'session_observability',
            'trace_diagnostics',
          ],
        },
      }),
    ).toBe(true);

    expect(
      shouldClarifyPageContextIntent({
        text: 'analyse this session',
        previousPageContext: undefined,
        currentPageContext: {
          area: 'project',
          page: 'sessions',
          entity: { type: 'session', id: 'sess-123', name: 'Checkout escalation' },
          capabilities: [
            'production_agent_optimization',
            'session_observability',
            'trace_diagnostics',
          ],
        },
      }),
    ).toBe(false);
  });

  it('does not ask for scope when the user names an aggregate scope or session id', () => {
    const listContext = {
      area: 'project',
      page: 'sessions',
      tab: 'conversations',
      capabilities: ['production_agent_optimization', 'session_observability', 'trace_diagnostics'],
    } as const;

    expect(
      shouldClarifyPageContextIntent({
        text: 'analyse all sessions',
        previousPageContext: undefined,
        currentPageContext: listContext,
      }),
    ).toBe(false);

    expect(
      shouldClarifyPageContextIntent({
        text: 'analyse session s-sdk_f6bb42ae-0862',
        previousPageContext: undefined,
        currentPageContext: listContext,
      }),
    ).toBe(false);
  });

  it('asks before switching to page analysis when a pending action exists', () => {
    expect(
      shouldClarifyPageContextIntent({
        text: 'analyze this',
        hasPendingAction: true,
        previousPageContext: {
          area: 'project',
          page: 'agents',
          entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
        },
        currentPageContext: {
          area: 'project',
          page: 'quality-monitor',
          capabilities: ['production_agent_optimization', 'quality_monitoring'],
        },
      }),
    ).toBe(true);
  });

  it('builds a short clarification appendix with both candidate focuses', () => {
    const appendix = buildPageContextClarificationAppendix({
      previousPageContext: {
        area: 'project',
        page: 'agents',
        entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
        tab: 'config',
      },
      currentPageContext: {
        area: 'project',
        page: 'tools',
        entity: { type: 'tool', id: 'tool-123', name: 'CRM Sync' },
        tab: 'testing',
      },
    });

    expect(appendix).toContain('agent "Billing_Agent"');
    expect(appendix).toContain('tool "CRM Sync"');
    expect(appendix).toContain('Use ask_user');
  });

  it('builds a scope question appendix for list-style analytics pages', () => {
    const appendix = buildPageContextClarificationAppendix({
      previousPageContext: undefined,
      currentPageContext: {
        area: 'project',
        page: 'sessions',
        tab: 'conversations',
        capabilities: [
          'production_agent_optimization',
          'session_observability',
          'trace_diagnostics',
        ],
      },
    });

    expect(appendix).toContain('no single session is selected');
    expect(appendix).toContain('all visible/filtered sessions');
    expect(appendix).toContain('specific session ID');
  });

  it('builds a pending-action confirmation appendix before switching context', () => {
    const appendix = buildPageContextClarificationAppendix({
      hasPendingAction: true,
      previousPageContext: {
        area: 'project',
        page: 'agents',
        entity: { type: 'agent', id: 'Billing_Agent', name: 'Billing_Agent' },
      },
      currentPageContext: {
        area: 'project',
        page: 'quality-monitor',
        capabilities: ['production_agent_optimization', 'quality_monitoring'],
      },
    });

    expect(appendix).toContain('pending Arch action or proposal');
    expect(appendix).toContain('continue the pending Arch action');
    expect(appendix).toContain('switch to analyzing the current page context');
  });
});
