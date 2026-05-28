import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BehaviorSection } from '@/components/agent-detail/BehaviorSection';
import type { BehaviorSectionData } from '@/store/agent-detail-store';

function makeData(overrides: Partial<BehaviorSectionData> = {}): BehaviorSectionData {
  return {
    profiles: [
      {
        name: 'voice_vip',
        priority: 5,
        whenSummary: 'channel == "voice"',
        overrideCategories: ['conversation'],
      },
    ],
    conversationBehavior: {
      speaking: {
        style: 'warm and concise',
        language_policy: 'interaction_context',
        tool_lead_in: 'brief',
      },
      interaction: {
        answer_shape: 'answer_first',
      },
    },
    ...overrides,
  };
}

describe('ConversationBehavior editor surface', () => {
  it('shows a collapsed summary for authored behavior and attached profiles', () => {
    render(
      <BehaviorSection
        data={makeData()}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    expect(
      screen.getByText('warm and concise • tool brief • answer first • 1 profile attached'),
    ).toBeInTheDocument();
  });

  it('updates speaking language policy and fixed language through the editor controls', () => {
    const handleChange = vi.fn();

    function Harness() {
      const [data, setData] = useState(makeData());

      return (
        <BehaviorSection
          data={data}
          isExpanded={true}
          onToggle={() => {}}
          onChange={(next) => {
            setData(next);
            handleChange(next);
          }}
        />
      );
    }

    render(<Harness />);

    const languagePolicy = screen.getByDisplayValue('Interaction Context');
    fireEvent.change(languagePolicy, { target: { value: 'fixed' } });

    const fixedLanguage = screen.getByPlaceholderText('en-US');
    fireEvent.change(fixedLanguage, { target: { value: 'en-US' } });

    expect(handleChange).toHaveBeenCalled();
    expect(handleChange.mock.calls.at(-1)?.[0]).toMatchObject({
      conversationBehavior: {
        speaking: {
          style: 'warm and concise',
          language_policy: 'fixed',
          fixed_language: 'en-US',
          tool_lead_in: 'brief',
        },
        interaction: {
          answer_shape: 'answer_first',
        },
      },
      profiles: [
        expect.objectContaining({
          name: 'voice_vip',
        }),
      ],
    });
  });
});
