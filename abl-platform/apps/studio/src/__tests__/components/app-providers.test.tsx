import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Providers } from '@/app/providers';
import { Tooltip } from '@/components/ui/Tooltip';

describe('app Providers', () => {
  it('provides tooltip context for route content', () => {
    expect(() =>
      render(
        <Providers>
          <Tooltip content="Helpful detail">
            <button type="button">Hover target</button>
          </Tooltip>
        </Providers>,
      ),
    ).not.toThrow();

    expect(screen.getByRole('button', { name: 'Hover target' })).toBeInTheDocument();
  });
});
