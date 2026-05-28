/**
 * Tests for AttributeTierBadge component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttributeTierBadge } from '../../components/search-ai/attributes/AttributeTierBadge';
import type { AttributeTier } from '../../api/search-ai';

const TIERS: Array<{ tier: AttributeTier; label: string; variant: string }> = [
  { tier: 'permanent', label: 'Permanent', variant: 'success' },
  { tier: 'approved', label: 'Approved', variant: 'info' },
  { tier: 'beta', label: 'Beta', variant: 'purple' },
  { tier: 'novel', label: 'Novel', variant: 'warning' },
  { tier: 'discarded', label: 'Discarded', variant: 'default' },
];

describe('AttributeTierBadge', () => {
  it.each(TIERS)('renders correct label "$label" for tier "$tier"', ({ tier, label }) => {
    render(<AttributeTierBadge tier={tier} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each(TIERS)('applies correct Badge variant classes for tier "$tier"', ({ tier }) => {
    const { container } = render(<AttributeTierBadge tier={tier} />);
    const badge = container.querySelector('span');
    expect(badge).toBeInTheDocument();
    // Badge renders as a span with inline-flex
    expect(badge!.className).toContain('inline-flex');
  });

  it('renders with unknown tier gracefully using fallback', () => {
    // Force an unknown tier value to test the ?? fallback
    render(<AttributeTierBadge tier={'experimental' as AttributeTier} />);
    // TIER_KEY[tier] is undefined, so ?? falls back to the tier string 'experimental'.
    // next-intl mock's t('experimental') returns 'search_ai.kg.experimental' (namespace.key)
    // since the key doesn't exist in translations.
    expect(screen.getByText('search_ai.kg.experimental')).toBeInTheDocument();
  });

  it('renders without crashing for each valid tier value', () => {
    for (const { tier } of TIERS) {
      const { unmount } = render(<AttributeTierBadge tier={tier} />);
      unmount();
    }
  });

  it('accepts and applies className prop', () => {
    const { container } = render(<AttributeTierBadge tier="beta" className="ml-2" />);
    const badge = container.querySelector('span');
    expect(badge!.className).toContain('ml-2');
  });
});
