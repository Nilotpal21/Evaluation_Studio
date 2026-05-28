import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import {
  getDefaultHyperParameterValues,
  HyperParameterForm,
} from '../../components/admin/HyperParameterForm';

describe('HyperParameterForm', () => {
  test('renders parameter help text without an external tooltip provider', async () => {
    const user = userEvent.setup();
    const description =
      'Controls the cumulative probability threshold for token sampling during generation.';

    const { container } = render(
      <HyperParameterForm
        parameters={[
          {
            type: 'rangeSlider',
            name: 'topP',
            unifiedParam: 'top_p',
            displayName: 'Top P',
            required: false,
            min: 0,
            max: 1,
            step: 0.1,
            defaultValue: 1,
            description,
          },
        ]}
        values={{ topP: 0.9 }}
        onChange={() => {}}
      />,
    );

    expect(container).not.toHaveTextContent(description);

    await user.hover(screen.getByRole('button', { name: 'Top P description' }));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(description);

    const portalContent = await waitFor(() => {
      const content = document.querySelector('[data-radix-popper-content-wrapper] > div');
      expect(content).toBeTruthy();
      expect(content).toHaveTextContent(description);
      return content as HTMLDivElement;
    });

    expect(portalContent).toHaveClass('bg-background-elevated', 'text-foreground');
    expect(container).not.toContainElement(portalContent);
  });

  test('renders nested thinking controls and emits runtime parameter keys', async () => {
    const user = userEvent.setup();
    const changes: Record<string, unknown> = {};

    render(
      <HyperParameterForm
        parameters={[
          {
            type: 'section',
            name: 'thinking',
            unifiedParam: 'thinking',
            displayName: 'Extended Thinking',
            required: false,
            description: 'Enable extended thinking mode for complex reasoning',
            hyperParameters: [
              {
                type: 'toggle',
                name: 'enabled',
                unifiedParam: 'thinking.enabled',
                displayName: 'Enable Thinking',
                required: false,
                defaultValue: false,
                description: 'Activate extended thinking mode',
              },
              {
                type: 'rangeSlider',
                name: 'budget_tokens',
                unifiedParam: 'thinking.budget_tokens',
                displayName: 'Thinking Budget (tokens)',
                required: false,
                defaultValue: 2048,
                min: 1024,
                max: 10000,
                step: 256,
                description: 'Token budget for thinking process',
              },
            ],
          },
        ]}
        values={{ enableThinking: false, thinkingBudget: 2048 }}
        onChange={(name, value) => {
          changes[name] = value;
        }}
      />,
    );

    await user.click(screen.getByRole('switch', { name: 'Enable Thinking' }));

    expect(changes.enableThinking).toBe(true);
    expect(screen.getByText('Extended Thinking')).toBeInTheDocument();
    expect(screen.getByText('Thinking Budget (tokens)')).toBeInTheDocument();
  });

  test('builds default values recursively using runtime keys', () => {
    expect(
      getDefaultHyperParameterValues([
        {
          type: 'section',
          name: 'thinking',
          unifiedParam: 'thinking',
          displayName: 'Extended Thinking',
          required: false,
          description: '',
          hyperParameters: [
            {
              type: 'toggle',
              name: 'enabled',
              unifiedParam: 'thinking.enabled',
              displayName: 'Enable Thinking',
              required: false,
              defaultValue: false,
              description: '',
            },
            {
              type: 'rangeSlider',
              name: 'budget_tokens',
              unifiedParam: 'thinking.budget_tokens',
              displayName: 'Thinking Budget',
              required: false,
              defaultValue: 2048,
              min: 1024,
              max: 10000,
              step: 256,
              description: '',
            },
          ],
        },
      ]),
    ).toEqual({ enableThinking: false, thinkingBudget: 2048 });
  });

  test('does not persist defaults for mutually-exclusive radio alternatives', () => {
    const parameters = [
      {
        type: 'radioButton' as const,
        name: 'samplingMethod',
        unifiedParam: 'samplingMethod',
        displayName: 'Sampling Method',
        required: false,
        description: '',
        valueMap: ['temperature', 'top_p'],
        options: [
          {
            type: 'rangeSlider' as const,
            name: 'temperature',
            unifiedParam: 'temperature',
            displayName: 'Temperature',
            required: false,
            description: '',
            defaultValue: 1,
            min: 0,
            max: 1,
            step: 0.1,
          },
          {
            type: 'rangeSlider' as const,
            name: 'top_p',
            unifiedParam: 'top_p',
            displayName: 'Top P',
            required: false,
            description: '',
            defaultValue: 0.7,
            min: 0,
            max: 1,
            step: 0.1,
          },
        ],
      },
    ];

    expect(getDefaultHyperParameterValues(parameters)).toEqual({});
    expect(getDefaultHyperParameterValues(parameters, { top_p: 0.8 })).toEqual({ top_p: 0.8 });
  });
});
