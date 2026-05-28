/**
 * Lock test — API contracts for the canary components touched by Track 1
 * polish slices (Badge, InsightKPICard, Tabs).
 *
 * These are intentionally MINIMAL: each test pins the contract that a
 * specific Track 1 slice could regress, not the full visual rendering.
 * Pixel-level surface lock lives in the studio-video-evidence
 * `audit-canary-baseline` scenario; this file pins the structural
 * contracts that make those visuals possible.
 *
 * Pinned contracts:
 *   - Badge accepts every documented variant and renders with a
 *     variant-specific Tailwind class. Track 1.2 (outlined-status) MUST
 *     keep these variants reachable.
 *   - InsightKPICard applies the status-specific value color class.
 *     Track 1.5 (status row tint) and Track 1.10 (Hero KPI mono 36px)
 *     MUST keep this mapping intact.
 *   - Tabs hides the count badge when count is undefined OR zero, and
 *     renders it when count is positive. Track 1.2 (outlined-status)
 *     and Track 1.3 (section label rhythm) MUST keep this guard.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { Badge, type BadgeAppearance, type BadgeVariant } from '@/components/ui/Badge';
import { MetricCard } from '@/components/ui/MetricCard';
import { Tabs } from '@/components/ui/Tabs';
import { InsightKPICard } from '@/components/insights/shared/InsightKPICard';
import { SECTION_LABEL_CLASS } from '@/lib/typography';

describe('Badge — variant contract lock', () => {
  const VARIANTS: BadgeVariant[] = [
    'default',
    'accent',
    'success',
    'warning',
    'error',
    'info',
    'purple',
  ];

  for (const variant of VARIANTS) {
    test(`accepts variant="${variant}" and renders status text`, () => {
      render(
        <Badge variant={variant} testid={`badge-${variant}`}>
          {variant.toUpperCase()}
        </Badge>,
      );
      const el = screen.getByTestId(`badge-${variant}`);
      expect(el).toBeInTheDocument();
      expect(el.textContent).toContain(variant.toUpperCase());
      // Variant must apply at least one variant-specific class so the
      // CSS color stays bound to the variant prop.
      const className = el.getAttribute('class') ?? '';
      // Every non-default variant must include its name token in the className.
      if (variant !== 'default') {
        expect(className).toMatch(new RegExp(`\\b(?:bg|text)-${variant}`));
      }
    });
  }

  // Track 1.2 — outlined appearance must apply a `border-{variant}` class
  // and a transparent fill (no `bg-{variant}-subtle`). Default variant in
  // outlined appearance uses `border-default` (custom utility in
  // index.css), so it is excluded from the variant-name regex check.
  const NON_DEFAULT_VARIANTS: BadgeVariant[] = VARIANTS.filter((v) => v !== 'default');
  for (const variant of NON_DEFAULT_VARIANTS) {
    test(`appearance="outlined" + variant="${variant}" applies border-${variant}`, () => {
      render(
        <Badge variant={variant} appearance="outlined" testid={`badge-outlined-${variant}`}>
          {variant}
        </Badge>,
      );
      const el = screen.getByTestId(`badge-outlined-${variant}`);
      const className = el.getAttribute('class') ?? '';
      expect(className).toContain(`border-${variant}`);
      expect(className).toContain(`text-${variant}`);
      // Outlined must NOT carry the subtle fill — that is the whole point
      // of the appearance.
      expect(className).not.toContain(`bg-${variant}-subtle`);
    });
  }

  test('appearance defaults to "subtle" (existing call sites unchanged)', () => {
    // No appearance prop -> existing subtle-fill rendering preserved.
    render(
      <Badge variant="success" testid="badge-default-appearance">
        ok
      </Badge>,
    );
    const el = screen.getByTestId('badge-default-appearance');
    const className = el.getAttribute('class') ?? '';
    expect(className).toContain('bg-success-subtle');
    expect(className).not.toContain('border-success');
  });

  // BadgeAppearance type is exported (callers need it for prop typing).
  test('BadgeAppearance type export is reachable', () => {
    const a: BadgeAppearance = 'outlined';
    const b: BadgeAppearance = 'subtle';
    expect([a, b]).toEqual(['outlined', 'subtle']);
  });
});

describe('InsightKPICard — status-to-value-color contract lock', () => {
  const STATUS_TO_VALUE_CLASS: Record<'healthy' | 'warning' | 'critical', string> = {
    healthy: 'text-foreground',
    warning: 'text-warning',
    critical: 'text-error',
  };

  for (const status of Object.keys(STATUS_TO_VALUE_CLASS) as Array<
    keyof typeof STATUS_TO_VALUE_CLASS
  >) {
    test(`status="${status}" applies "${STATUS_TO_VALUE_CLASS[status]}" to the value`, () => {
      const { container } = render(<InsightKPICard title="Test KPI" value="42%" status={status} />);
      // The value paragraph is the truncate `<p>` rendered by InsightKPICard.
      const valueParagraph = container.querySelector('p.truncate');
      expect(valueParagraph).not.toBeNull();
      expect(valueParagraph?.getAttribute('class')).toContain(STATUS_TO_VALUE_CLASS[status]);
    });
  }

  test('value paragraph applies tabular-nums (Track 1.1 lock)', () => {
    // Track 1.1: every KPI primitive must keep digits column-aligned via
    // tabular-nums. If a slice strips this class from the value paragraph,
    // numeric columns wobble across rows.
    const { container } = render(<InsightKPICard title="Lock" value="1,234" />);
    const valueParagraph = container.querySelector('p.truncate');
    expect(valueParagraph).not.toBeNull();
    expect(valueParagraph?.getAttribute('class')).toContain('tabular-nums');
  });

  // Track 1.5 — non-healthy status applies a subtle row tint. The tint
  // opacity is intentionally low (~3% warning, ~4% error); regressing
  // it to a saturated `bg-warning` would create the Christmas-tree
  // problem the slice was designed to prevent.
  test('status="warning" applies the warning row tint (Track 1.5 lock)', () => {
    const { container } = render(<InsightKPICard title="Lock" value="1" status="warning" />);
    const card = container.firstElementChild;
    expect(card?.getAttribute('class')).toContain('bg-warning/[0.03]');
  });

  test('status="critical" applies the error row tint (Track 1.5 lock)', () => {
    const { container } = render(<InsightKPICard title="Lock" value="1" status="critical" />);
    const card = container.firstElementChild;
    expect(card?.getAttribute('class')).toContain('bg-error/[0.04]');
  });

  test('status="healthy" applies no row tint (Track 1.5 lock)', () => {
    const { container } = render(<InsightKPICard title="Lock" value="1" status="healthy" />);
    const card = container.firstElementChild;
    const className = card?.getAttribute('class') ?? '';
    expect(className).not.toMatch(/\bbg-warning\//);
    expect(className).not.toMatch(/\bbg-error\//);
  });
});

describe('MetricCard — section label + tabular-nums contract lock', () => {
  test('label renders with the canonical SECTION_LABEL_CLASS (Track 1.3)', () => {
    // Track 1.3: section labels across MetricCard, settings group titles,
    // and table column headers must converge on a single typography
    // pattern. SECTION_LABEL_CLASS is the source of truth; if a slice
    // strips one of the four atoms (size / weight / case / tracking /
    // color), this lock fires.
    const { container } = render(<MetricCard label="Active Sessions" value="1,234" />);
    const labelSpan = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'Active Sessions',
    );
    expect(labelSpan).toBeDefined();
    expect(labelSpan?.getAttribute('class')).toBe(SECTION_LABEL_CLASS);
  });

  test('value paragraph applies tabular-nums (Track 1.1)', () => {
    const { container } = render(<MetricCard label="Lock" value="9,999" />);
    const valueParagraph = container.querySelector('p.text-2xl');
    expect(valueParagraph).not.toBeNull();
    expect(valueParagraph?.getAttribute('class')).toContain('tabular-nums');
  });
});

describe('Tabs — count guard contract lock', () => {
  test('renders the count chip when count > 0', () => {
    render(
      <Tabs
        tabs={[{ id: 'a', label: 'Alpha', count: 5, testid: 'tab-alpha' }]}
        activeTab="a"
        onTabChange={() => {}}
      />,
    );
    const chip = screen.getByText('5');
    expect(chip).toBeInTheDocument();
  });

  test('hides the count chip when count is 0', () => {
    render(
      <Tabs
        tabs={[{ id: 'b', label: 'Beta', count: 0, testid: 'tab-beta' }]}
        activeTab="b"
        onTabChange={() => {}}
      />,
    );
    expect(screen.queryByText('0')).toBeNull();
  });

  test('hides the count chip when count is undefined', () => {
    render(
      <Tabs
        tabs={[{ id: 'c', label: 'Gamma', testid: 'tab-gamma' }]}
        activeTab="c"
        onTabChange={() => {}}
      />,
    );
    // No numeric text other than the label.
    const tab = screen.getByTestId('tab-gamma');
    expect(tab.textContent).toBe('Gamma');
  });
});
