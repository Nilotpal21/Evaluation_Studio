/**
 * @vitest-environment happy-dom
 */

import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CommandPalette } from '../../components/CommandPalette';
import { useNavigationStore } from '../../store/navigation-store';

const fetchAppsMock = vi.fn();
const loadAppMock = vi.fn();

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'agents_count') {
      return `${String(values?.count ?? 0)} agents`;
    }
    return key;
  },
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock('cmdk', () => {
  const Command = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  );

  Command.Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />;
  Command.List = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  );
  Command.Empty = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  );
  Command.Group = ({
    children,
    heading,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { heading?: string }) => (
    <div {...props}>
      {heading ? <div>{heading}</div> : null}
      {children}
    </div>
  );
  Command.Item = ({
    children,
    onSelect,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    onSelect?: (value?: string) => void;
  }) => (
    <button type="button" onClick={() => onSelect?.()} {...props}>
      {children}
    </button>
  );

  return { Command };
});

vi.mock('lucide-react', async () => {
  const actual = await vi.importActual<typeof import('lucide-react')>('lucide-react');
  const Icon = (props: React.HTMLAttributes<HTMLSpanElement>) => <span {...props} />;

  return Object.fromEntries(Object.keys(actual).map((key) => [key, Icon]));
});

vi.mock('../../hooks/useAvailableApps', () => ({
  useAvailableApps: () => ({
    availableApps: [
      {
        name: 'Travel Desk',
        domain: 'proj-1',
        entryAgent: 'triage_agent',
        agentCount: 3,
      },
    ],
    fetchApps: fetchAppsMock,
    loadApp: loadAppMock,
    loading: false,
    loadingApp: false,
    error: null,
  }),
}));

describe('CommandPalette', () => {
  beforeEach(() => {
    fetchAppsMock.mockReset();
    loadAppMock.mockReset();
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'agents',
      subPage: 'triage_agent',
      tab: null,
      subSection: null,
      subPageLabel: null,
      breadcrumbs: [],
    });
  });

  test('loads the selected app even when rendered outside the websocket provider', () => {
    render(<CommandPalette open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByText('Travel Desk'));

    expect(loadAppMock).toHaveBeenCalledTimes(1);
    expect(loadAppMock).toHaveBeenCalledWith('proj-1');
    expect(useNavigationStore.getState().tab).toBeNull();
  });
});
