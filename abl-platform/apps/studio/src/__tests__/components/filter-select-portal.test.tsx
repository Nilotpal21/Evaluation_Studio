/**
 * FilterSelect portal interaction tests
 *
 * Verifies option selection still works when the dropdown menu is rendered
 * into `document.body` via a portal.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterSelect } from '../../components/ui/FilterSelect';

describe('FilterSelect portal behavior', () => {
  it('selects an option from the portaled menu without closing early', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <FilterSelect
        options={[
          { value: 'all', label: 'All Items' },
          { value: 'active', label: 'Active' },
          { value: 'archived', label: 'Archived' },
        ]}
        value="all"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: /all items/i }));
    await user.click(screen.getByRole('button', { name: /^active$/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('active');
    expect(screen.queryByRole('button', { name: /^archived$/i })).not.toBeInTheDocument();
  });
});
