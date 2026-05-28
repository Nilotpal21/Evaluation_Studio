/**
 * Render tests for SpecialistChip — the compact ~24px-tall variant of
 * SpecialistBadge used in ArchHeroStrip.
 *
 * Pins the contract documented in the component:
 *   - lowercase rendering of the specialist name
 *   - `icon` prop is a key into ICON_MAP, NOT a specialist id
 *   - unknown icon keys fall back to Bot + FALLBACK_STYLE
 *   - `title` attribute carries the active-specialist hover label
 *
 * Uses @testing-library/react against the existing Studio happy-dom setup
 * (apps/studio/vitest.config.ts). No platform mocks.
 */

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { SpecialistChip } from '../SpecialistChip';
import { FALLBACK_STYLE } from '../specialist-style';

describe('<SpecialistChip />', () => {
  it('renders the specialist name in lowercase styling', () => {
    const { container, getByText } = render(
      <SpecialistChip name="integration-methodologist" icon="network" />,
    );
    // The name is rendered verbatim; the lowercase visual is via Tailwind
    // `lowercase` class on the inner span — assert both:
    const nameSpan = getByText('integration-methodologist');
    expect(nameSpan).toBeInTheDocument();
    expect(nameSpan.className).toContain('lowercase');
    // Sanity: the component renders a single chip element.
    expect(container.querySelectorAll('span[title]')).toHaveLength(1);
  });

  it('renders the Network lucide icon for icon="network"', () => {
    const { container } = render(
      <SpecialistChip name="integration-methodologist" icon="network" />,
    );
    // Lucide icons render as <svg class="lucide lucide-network ...">.
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // happy-dom preserves the lucide class name regardless of token mode.
    expect(svg?.getAttribute('class') ?? '').toMatch(/lucide-network/);
  });

  it('falls back to Bot icon and FALLBACK_STYLE when icon key is unknown', () => {
    const { container } = render(
      <SpecialistChip name="mystery-specialist" icon="not-a-real-icon-key" />,
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('class') ?? '').toMatch(/lucide-bot/);

    // Fallback style class names must be present on the chip.
    const html = container.innerHTML;
    // FALLBACK_STYLE.label and FALLBACK_STYLE.dot reference token classes;
    // both should be applied somewhere in the chip markup.
    expect(html).toContain(FALLBACK_STYLE.label);
    expect(html).toContain(FALLBACK_STYLE.dot);
  });

  it('exposes the specialist name in the title attribute for hover affordance', () => {
    const { container } = render(<SpecialistChip name="abl-construct-expert" icon="code" />);
    const chip = container.querySelector('span[title]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('title')).toBe('Active specialist: abl-construct-expert');
  });
});
