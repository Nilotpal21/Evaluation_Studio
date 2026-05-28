import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  IntegrationSuggestionCard,
  type IntegrationSuggestionPayload,
} from '../IntegrationSuggestionCard';
import { useArchAIStore } from '../../../../store/arch-ai-store';

const basePayload: IntegrationSuggestionPayload = {
  title: 'Connect a Slack workspace',
  rationale: 'The notifier agent needs Slack to post updates.',
  providerOptions: [
    { name: 'Slack', providerKey: 'slack' },
    { name: 'Microsoft Teams', providerKey: 'msteams' },
  ],
  targetAgentNames: ['notifier'],
};

describe('IntegrationSuggestionCard', () => {
  beforeEach(() => {
    useArchAIStore.getState().setPrefillMessage(null);
  });

  it('renders title, rationale, and a button per provider', () => {
    render(<IntegrationSuggestionCard event={basePayload} />);

    expect(screen.getByText(/connect a slack workspace/i)).toBeTruthy();
    expect(screen.getByText(/notifier agent needs slack/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Slack' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Microsoft Teams' })).toBeTruthy();
  });

  it('clicking a provider button writes the prefill (metadata if available, else fallback message)', () => {
    // The store may or may not have setPrefillMetadata yet (added in Task 4.1).
    // Either way, clicking the button must record an actionable prefill.
    const storeWithMetadata = useArchAIStore.getState() as unknown as {
      setPrefillMetadata?: (m: unknown) => void;
    };

    let captured: unknown = null;
    if (typeof storeWithMetadata.setPrefillMetadata === 'function') {
      const original = storeWithMetadata.setPrefillMetadata.bind(storeWithMetadata);
      storeWithMetadata.setPrefillMetadata = (m: unknown) => {
        captured = m;
        original(m);
      };
    }

    render(<IntegrationSuggestionCard event={basePayload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Slack' }));

    if (typeof storeWithMetadata.setPrefillMetadata === 'function') {
      expect(captured).toEqual({
        kind: 'start_integration',
        providerKey: 'slack',
        targetAgentNames: ['notifier'],
      });
    } else {
      // Fallback path: setPrefillMessage was called with a constructed string.
      expect(useArchAIStore.getState().prefillMessage).toBe('Connect slack for notifier');
    }
  });
});
