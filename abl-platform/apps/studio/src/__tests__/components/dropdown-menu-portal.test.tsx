import type { ComponentProps, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DropdownMenu, DropdownMenuItem } from '../../components/ui/DropdownMenu';

vi.mock('@radix-ui/react-dropdown-menu', () => ({
  Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Trigger: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Portal: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-portal">{children}</div>
  ),
  Content: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div role="menu" className={className}>
      {children}
    </div>
  ),
  Item: ({ children, ...props }: ComponentProps<'div'>) => (
    <div role="menuitem" {...props}>
      {children}
    </div>
  ),
  Separator: (props: ComponentProps<'div'>) => <div {...props} />,
  Label: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
}));

describe('DropdownMenu', () => {
  it('renders menu content through a portal wrapper', () => {
    render(
      <DropdownMenu trigger={<span>Open menu</span>}>
        <DropdownMenuItem onSelect={() => {}}>Invite member</DropdownMenuItem>
      </DropdownMenu>,
    );

    const portal = screen.getByTestId('dropdown-portal');
    expect(portal).toContainElement(screen.getByRole('menu'));
    expect(screen.getByText('Invite member')).toBeInTheDocument();
  });
});
