import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WidgetRenderer } from '../WidgetRenderer';
import {
  askUserSchema,
  oauthLaunchInputSchema,
  integrationPlanInputSchema,
} from '../../../../tool-schemas';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

// External hook used by OAuthLaunch — mocked at UI boundary so the
// widget can mount without real popup machinery.
vi.mock('@/hooks/useBatchOAuth', () => ({
  useBatchOAuth: () => ({
    startOAuth: vi.fn(),
    connectAll: vi.fn(),
    isConnecting: false,
    statuses: {},
  }),
}));

afterEach(() => {
  useArchAIStore.setState({
    artifactTabs: [],
    activeTabId: null,
    overlayState: 'closed',
  });
});

describe('WidgetRenderer — OAuthLaunch + IntegrationPlan registration', () => {
  it('renders OAuthLaunch widget when widgetType is OAuthLaunch', () => {
    render(
      <WidgetRenderer
        toolCallId="tc_1"
        toolName="ask_user"
        input={{
          question: 'Connect Slack',
          widgetType: 'OAuthLaunch',
          authProfileId: 'ap_1',
          authProfileRef: 'authprofile:ap_1',
          connectorName: 'slack',
          connectionMode: 'per_user',
          scopes: ['chat:write'],
          providerLabel: 'Slack',
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /connect to slack/i })).toBeTruthy();
    expect(document.querySelector('[data-widget="OAuthLaunch"]')).toBeTruthy();
  });

  it('renders IntegrationPlan widget when widgetType is IntegrationPlan', () => {
    render(
      <WidgetRenderer
        toolCallId="tc_2"
        toolName="ask_user"
        input={{
          question: 'Approve plan',
          widgetType: 'IntegrationPlan',
          rationale: 'Wire up Slack',
          steps: [
            { id: 's1', description: 'Authorize workspace' },
            { id: 's2', description: 'Pick channel' },
          ],
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText(/wire up slack/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
  });

  it('renders collect_secret with a stable SecretInput widget selector', () => {
    render(
      <WidgetRenderer
        toolCallId="tc_secret"
        toolName="collect_secret"
        input={{
          flowId: 'flow-1',
          field: 'clientSecret',
          label: 'Client secret',
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('Client secret')).toBeTruthy();
    expect(document.querySelector('[data-widget="SecretInput"]')).toBeTruthy();
  });

  it('renders proposal Confirmation as a review-panel status mirror when a pending diff exists', () => {
    const onSubmit = vi.fn();
    useArchAIStore.setState({
      artifactTabs: [
        {
          id: 'diff-1',
          type: 'diff',
          label: 'Changes',
          toolCallId: 'tool-1',
          data: {
            reviewStatus: 'pending',
            agentName: 'FlowStep',
            changes: [],
          },
        },
      ],
      activeTabId: null,
      overlayState: 'chat',
    });

    render(
      <WidgetRenderer
        toolCallId="tc_3"
        toolName="ask_user"
        input={{
          question: 'Apply proposed changes?',
          widgetType: 'Confirmation',
          confirmLabel: 'Apply Changes',
          denyLabel: 'Reject',
        }}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText('Proposal pending in the review panel.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /apply changes/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /open review/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(useArchAIStore.getState().activeTabId).toBe('diff-1');
    expect(useArchAIStore.getState().overlayState).toBe('artifacts');
  });

  it('submits a confirmation only once under rapid clicks', () => {
    const onSubmit = vi.fn();

    render(
      <WidgetRenderer
        toolCallId="tc_confirm"
        toolName="ask_user"
        input={{
          question: 'Approve the fix plan?',
          widgetType: 'Confirmation',
          confirmLabel: 'Approve Plan',
          denyLabel: 'Revise Plan',
        }}
        onSubmit={onSubmit}
      />,
    );

    const approveButton = screen.getByRole('button', { name: /approve plan/i });
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('tc_confirm', true, undefined);
  });
});

describe('tool-schemas — OAuthLaunch + IntegrationPlan', () => {
  it('validates a valid OAuthLaunch input', () => {
    const result = oauthLaunchInputSchema.safeParse({
      authProfileId: 'ap_1',
      authProfileRef: 'authprofile:ap_1',
      connectorName: 'slack',
      connectionMode: 'per_user',
      scopes: ['chat:write'],
      providerLabel: 'Slack',
    });
    expect(result.success).toBe(true);
  });

  it('rejects OAuthLaunch input with empty authProfileId', () => {
    const result = oauthLaunchInputSchema.safeParse({
      authProfileId: '',
      authProfileRef: 'authprofile:ap_1',
      connectorName: 'slack',
      connectionMode: 'per_user',
      scopes: ['chat:write'],
      providerLabel: 'Slack',
    });
    expect(result.success).toBe(false);
  });

  it('validates an IntegrationPlan input', () => {
    const result = integrationPlanInputSchema.safeParse({
      steps: [{ id: 's1', description: 'Authorize workspace' }],
      rationale: 'Wire up Slack',
    });
    expect(result.success).toBe(true);
  });

  it('askUserSchema accepts the new widget types', () => {
    const oauthOk = askUserSchema.safeParse({
      question: 'Connect',
      widgetType: 'OAuthLaunch',
    });
    const planOk = askUserSchema.safeParse({
      question: 'Approve plan',
      widgetType: 'IntegrationPlan',
    });
    expect(oauthOk.success).toBe(true);
    expect(planOk.success).toBe(true);
  });
});
