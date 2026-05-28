import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { ToolTestPanel } from '../../components/tools/ToolTestPanel';
import type { ToolTestResult } from '../../store/tool-store';

describe('ToolTestPanel', () => {
  test('renders copy and expand actions for structured result blocks', async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const onTest = vi.fn<() => Promise<ToolTestResult>>().mockResolvedValue({
      output: {
        answer: 'ok',
        nested: {
          count: 2,
        },
      },
      latencyMs: 42,
      logs: ['request started', 'request finished'],
      response: {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"ok":true}',
      },
    });

    render(<ToolTestPanel onTest={onTest} />);

    await user.click(screen.getByRole('button', { name: /run test/i }));

    await screen.findByText('Success');

    const outputSection = screen.getByText('Output').parentElement;
    expect(outputSection).not.toBeNull();
    expect(within(outputSection as HTMLElement).getByLabelText('Copy JSON')).toBeInTheDocument();
    expect(
      within(outputSection as HTMLElement).getByLabelText('Expand fullscreen'),
    ).toBeInTheDocument();

    const logsSection = screen.getByText('Logs').parentElement;
    expect(logsSection).not.toBeNull();
    const logsCopyButton = within(logsSection as HTMLElement).getByLabelText('Copy');
    const logsExpandButton = within(logsSection as HTMLElement).getByLabelText('Expand fullscreen');

    await user.click(logsCopyButton);
    expect(writeTextSpy).toHaveBeenCalledWith('request started\nrequest finished');

    await user.click(logsExpandButton);
    expect(screen.getByLabelText('Close')).toBeInTheDocument();

    const responseHeader = screen.getByText('Response').closest('button');
    expect(responseHeader).not.toBeNull();
    const responsePanel = responseHeader?.parentElement;
    expect(responsePanel).not.toBeNull();
    expect(within(responsePanel as HTMLElement).getByLabelText('Copy JSON')).toBeInTheDocument();
    expect(within(responsePanel as HTMLElement).getByLabelText('Copy')).toBeInTheDocument();
    expect(
      within(responsePanel as HTMLElement).getAllByLabelText('Expand fullscreen'),
    ).toHaveLength(2);
  });
});
