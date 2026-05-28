import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { TextInput } from '../../lib/arch-ai/components/arch/widgets/TextInput';
import { MultiSelect } from '../../lib/arch-ai/components/arch/widgets/MultiSelect';
import { SingleSelect } from '../../lib/arch-ai/components/arch/widgets/SingleSelect';

describe('arch-ai widget prefills', () => {
  test('TextInput renders defaultValue as editable text', () => {
    render(
      <TextInput
        input={{
          question: 'Describe the assistant',
          widgetType: 'TextInput',
          multiline: true,
          defaultValue: 'Search flights, book tickets, and manage reservations.',
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByDisplayValue('Search flights, book tickets, and manage reservations.'),
    ).toBeTruthy();
  });

  test('TextInput falls back to example-style placeholders as starter drafts', () => {
    render(
      <TextInput
        input={{
          question: 'Describe the assistant',
          widgetType: 'TextInput',
          multiline: true,
          placeholder: 'e.g., search flights, compare fares, and help with check-in',
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByDisplayValue('search flights, compare fares, and help with check-in'),
    ).toBeTruthy();
  });

  test('MultiSelect submits prefilled defaults without additional edits', () => {
    const onSubmit = vi.fn();

    render(
      <MultiSelect
        input={{
          question: 'Which channels should it support?',
          widgetType: 'MultiSelect',
          options: [
            { label: 'Web Chat', value: 'web_chat' },
            { label: 'Voice', value: 'voice' },
          ],
          allowCustom: true,
          defaultValues: ['voice', 'WhatsApp'],
        }}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith(['voice', 'Custom: WhatsApp']);
  });

  test('SingleSelect opens the custom input prefilled for unmatched defaults', () => {
    render(
      <SingleSelect
        input={{
          question: 'What should we call the project?',
          widgetType: 'SingleSelect',
          options: [
            { label: 'FlightBot', value: 'FlightBot' },
            { label: 'TravelAssist', value: 'TravelAssist' },
          ],
          allowCustom: true,
          defaultValue: 'SkyDesk',
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('SkyDesk')).toBeTruthy();
    expect(document.querySelector('[data-widget="SingleSelect"]')).toBeTruthy();
    expect(document.querySelector('[data-value="FlightBot"]')).toBeTruthy();
  });
});
