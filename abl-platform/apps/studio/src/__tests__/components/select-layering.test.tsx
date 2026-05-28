/**
 * Select layering regression tests
 *
 * Guards the shared Select content layer so portaled dropdowns stay above
 * dialog and slide-panel overlays in flows like SDK channel creation and
 * deployment creation.
 */

import type { ComponentProps, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Select, SELECT_CONTENT_LAYER_CLASS } from '../../components/ui/Select';

vi.mock('@radix-ui/react-select', () => ({
  Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Trigger: ({ children, ...props }: ComponentProps<'button'>) => (
    <button role="combobox" type="button" {...props}>
      {children}
    </button>
  ),
  Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  Icon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Content: ({
    children,
    className,
    position,
    sideOffset,
    ...props
  }: {
    children: ReactNode;
    className?: string;
    position?: string;
    sideOffset?: number;
  }) => (
    <div role="listbox" className={className} data-state="open" {...props}>
      {children}
    </div>
  ),
  Viewport: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
  Item: ({ children, ...props }: ComponentProps<'div'>) => (
    <div role="option" {...props}>
      {children}
    </div>
  ),
  ItemIndicator: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ItemText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

describe('Select layering', () => {
  it('applies a dialog-safe z-index to portaled content', () => {
    render(
      <Select
        label="Entry agent"
        options={[
          { value: 'agent-alpha', label: 'Agent Alpha' },
          { value: 'agent-beta', label: 'Agent Beta' },
        ]}
        placeholder="Select an entry agent"
        value=""
        onChange={() => {}}
      />,
    );

    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveClass(SELECT_CONTENT_LAYER_CLASS);
    expect(listbox.className).not.toContain('z-50');
    expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
    expect(screen.getByText('Agent Beta')).toBeInTheDocument();
  });
});
