/**
 * PostInstallChecklist Component Tests
 *
 * Tests the post-install checklist that displays provisioning requirements
 * and applied counts after a template installation.
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PostInstallChecklist } from '../../../components/marketplace/PostInstallChecklist';
import type { AppliedCounts, ProvisioningReport } from '@/api/template-install';

const emptyProvisioning: ProvisioningReport = {
  envVars: [],
  connectors: [],
  mcpServers: [],
  authProfiles: [],
};

const fullApplied: AppliedCounts = {
  created: 3,
  updated: 0,
  deleted: 0,
  toolsCreated: 5,
  toolsUpdated: 0,
  toolsDeleted: 0,
  localesCreated: 0,
  localesUpdated: 0,
  localesDeleted: 0,
  profilesCreated: 0,
  profilesUpdated: 0,
  profilesDeleted: 0,
  evalsCreated: 0,
  evalsUpdated: 0,
  evalsDeleted: 0,
  modelPoliciesUpserted: 0,
  modelPoliciesDeleted: 0,
};

describe('PostInstallChecklist', () => {
  it('renders install summary with agent and tool counts', () => {
    render(
      <PostInstallChecklist
        applied={fullApplied}
        provisioningRequired={emptyProvisioning}
        entryAgentName="greeter"
      />,
    );

    // Summary: "3 agents and 5 tools created"
    expect(screen.getByText('3 agents and 5 tools created')).toBeTruthy();
    // Entry agent name
    expect(screen.getByText(/Entry Agent: greeter/)).toBeTruthy();
  });

  it('shows provisioning items when env vars and connectors required', () => {
    const provisioning: ProvisioningReport = {
      envVars: ['OPENAI_API_KEY', 'DATABASE_URL'],
      connectors: ['Slack'],
      mcpServers: [],
      authProfiles: [],
    };

    render(
      <PostInstallChecklist
        applied={fullApplied}
        provisioningRequired={provisioning}
        entryAgentName={null}
      />,
    );

    // Provisioning header
    expect(screen.getByText('Post-install setup required')).toBeTruthy();
    // Env vars
    expect(screen.getByText('Environment Variables')).toBeTruthy();
    expect(screen.getByText('OPENAI_API_KEY')).toBeTruthy();
    expect(screen.getByText('DATABASE_URL')).toBeTruthy();
    // Connectors
    expect(screen.getByText('Connectors')).toBeTruthy();
    expect(screen.getByText('Slack')).toBeTruthy();
  });

  it('handles empty provisioning — no requirements', () => {
    render(
      <PostInstallChecklist
        applied={fullApplied}
        provisioningRequired={emptyProvisioning}
        entryAgentName={null}
      />,
    );

    // Should show "no additional setup required" message
    expect(screen.getByText('No additional setup required — ready to use')).toBeTruthy();
    // Should NOT show the provisioning header
    expect(screen.queryByText('Post-install setup required')).toBeNull();
  });

  it('renders nothing special when no provisioning data provided', () => {
    render(<PostInstallChecklist />);

    // Without provisioningRequired, no provisioning sections render
    expect(screen.queryByText('Post-install setup required')).toBeNull();
    expect(screen.queryByText('No additional setup required — ready to use')).toBeNull();
  });

  it('does not show entry agent when entryAgentName is null', () => {
    render(
      <PostInstallChecklist
        applied={fullApplied}
        provisioningRequired={emptyProvisioning}
        entryAgentName={null}
      />,
    );

    expect(screen.queryByText(/Entry Agent/)).toBeNull();
  });
});
