/**
 * Agent Transfer UI — Data Validation Tests
 *
 * Verifies that UI constants match the IR schema after
 * the provider/priority/channel alignment fixes.
 * Uses file-read approach to avoid heavy component imports.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STUDIO_SRC = path.resolve(__dirname, '..');

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(STUDIO_SRC, relativePath), 'utf-8');
}

describe('TransferSessionsPage constants', () => {
  const source = readFile('components/operate/TransferSessionsPage.tsx');

  it('provider options are loaded dynamically from configured connections (no static list)', () => {
    // Static PROVIDER_OPTIONS was replaced by dynamic options from useConnections + getProviderDef
    expect(source).toMatch(/useConnections/);
    expect(source).toMatch(/getProviderDef/);
    expect(source).toMatch(/providerOptions/);
    // No hardcoded provider value list
    expect(source).not.toMatch(/PROVIDER_OPTIONS\s*=/);
  });

  it('CHANNEL_OPTIONS contains campaign', () => {
    expect(source).toMatch(/value:\s*['"]campaign['"]/);
  });

  it('has toast.error in handleEndSession catch block', () => {
    expect(source).toMatch(/toast\.error/);
    expect(source).toMatch(/sanitizeError/);
  });

  it('has Channel column in the table', () => {
    // Channel should appear as a table header
    expect(source).toMatch(/Channel/);
    expect(source).toMatch(/session\.channel/);
  });
});

describe('EscalationEditor constants', () => {
  const source = readFile('components/agent-editor/sections/EscalationEditor.tsx');

  it('PRIORITY_OPTIONS contains medium and critical (not normal or urgent)', () => {
    // Verify the PRIORITY_OPTIONS definition
    expect(source).toMatch(/['"]medium['"]/);
    expect(source).toMatch(/['"]critical['"]/);
    // Should not have old values in the options array
    const optionsMatch = source.match(/PRIORITY_OPTIONS\s*=\s*\[([^\]]+)\]/);
    expect(optionsMatch).toBeTruthy();
    const optionsContent = optionsMatch![1];
    expect(optionsContent).not.toContain("'normal'");
    expect(optionsContent).not.toContain("'urgent'");
    expect(optionsContent).toContain("'medium'");
    expect(optionsContent).toContain("'critical'");
  });

  it('has Voice Settings sub-section with transferMethod', () => {
    expect(source).toMatch(/Voice Settings/);
    expect(source).toMatch(/transferMethod/);
    expect(source).toMatch(/sipHeaders/);
  });
});

describe('AgentTransferSettingsPage', () => {
  const source = readFile('components/settings/AgentTransferSettingsPage.tsx');

  it('has error handling in handleReset', () => {
    expect(source).toMatch(/toast\.error/);
    expect(source).toMatch(/sanitizeError/);
  });

  it('uses the session lifecycle hook for transfer TTL persistence', () => {
    expect(source).toMatch(/useSessionLifecycleSettings/);
    expect(source).toMatch(/saveLifecyclePatch/);
    expect(source).toMatch(/buildTransferTtlPatch/);
  });

  it('shows selected connection fidelity metadata and stale-connection warnings', () => {
    expect(source).toMatch(/ConnectionMetadataItem/);
    expect(source).toMatch(/getProviderDef/);
    expect(source).toMatch(/connection_missing_title/);
    expect(source).toMatch(/connection_incompatible_title/);
    expect(source).toMatch(/connection_inactive_title/);
    expect(source).toMatch(/save_blocked_title/);
    expect(source).toMatch(/save_blocked_missing_reason/);
    expect(source).toMatch(/save_blocked_incompatible_reason/);
    expect(source).toMatch(/save_blocked_inactive_reason/);
    expect(source).toMatch(/connection_provider/);
    expect(source).toMatch(/connection_auth_profile/);
    expect(source).toMatch(/connection_last_updated/);
  });
});

describe('useAgentTransferSettings hook', () => {
  const source = readFile('hooks/useAgentTransferSettings.ts');

  it('has TTL conversion (seconds to minutes and back)', () => {
    // Should have division by 60 for loading and multiplication for saving
    expect(source).toMatch(/\/\s*60/);
    expect(source).toMatch(/\*\s*60/);
  });

  it('strips lifecycle-owned TTL values before saving legacy transfer settings', () => {
    expect(source).toMatch(/stripLifecycleOwnedTtl/);
    expect(source).toMatch(
      /updateAgentTransferSettings\(projectId!, stripLifecycleOwnedTtl\(uiToBackend\(settings\)\)\)/,
    );
  });
});

describe('useSessionLifecycleSettings hook', () => {
  const source = readFile('hooks/useSessionLifecycleSettings.ts');

  it('targets the dedicated session lifecycle API', () => {
    expect(source).toMatch(/session-lifecycle/);
    expect(source).toMatch(/savePatch/);
    expect(source).toMatch(/replace/);
  });
});

describe('parseEscalation defaults', () => {
  it('agent-detail-store uses medium as default priority', () => {
    const source = readFile('store/agent-detail-store.ts');
    const parseSection = source.match(/parseEscalation[\s\S]*?return \{[\s\S]*?\};/);
    expect(parseSection).toBeTruthy();
    expect(parseSection![0]).toContain("'medium'");
    expect(parseSection![0]).not.toMatch(/priority.*'normal'/);
  });

  it('useAgentEditorStore uses medium as default priority', () => {
    const source = readFile('components/agent-editor/hooks/useAgentEditorStore.ts');
    const parseSection = source.match(/parseEscalation[\s\S]*?return \{[\s\S]*?\};/);
    expect(parseSection).toBeTruthy();
    expect(parseSection![0]).toContain("'medium'");
    expect(parseSection![0]).not.toMatch(/priority.*'normal'/);
  });
});

describe('TransferSessionDetailModal', () => {
  const source = readFile('components/operate/TransferSessionDetailModal.tsx');

  it('displays CSAT and disposition fields', () => {
    expect(source).toMatch(/csatSurveyType/);
    expect(source).toMatch(/dispositionCode/);
  });

  it('has End Session button', () => {
    expect(source).toMatch(/onEndSession/);
    expect(source).toMatch(/End Session/);
  });
});
