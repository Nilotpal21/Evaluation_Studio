'use client';

/**
 * Shared field layout primitives for all section editors.
 *
 * Hierarchy:
 *   SubSection  — "Model", "Generation", "Timeouts" etc. (big heading with top spacing)
 *   Field       — "Primary Model", "Temperature" etc. (label + input, subtle bottom border)
 *   FieldRow    — Inline label + value on one line
 *
 * Usage:
 *   <SubSection title="Model">
 *     <Field label="Primary Model">
 *       <SelectField .../>
 *     </Field>
 *     <Field label="Fallback Model">
 *       <SelectField .../>
 *     </Field>
 *   </SubSection>
 */

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Select } from '../../ui/Select';

// =============================================================================
// SUB-SECTION — groups related fields under a heading
// =============================================================================

export function SubSection({
  title,
  children,
  first,
}: {
  title: string;
  children: ReactNode;
  /** Set true for the first sub-section to remove top margin */
  first?: boolean;
  /** @deprecated borders removed — spacing only */
  last?: boolean;
}) {
  return (
    <div className={clsx(first ? 'mt-0' : 'mt-8')}>
      <h4 className="text-sm font-semibold text-foreground-muted uppercase tracking-wider mb-3">
        {title}
      </h4>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

// =============================================================================
// FIELD — label + input with bottom separator
// =============================================================================

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
  /** @deprecated no longer used — borders are on SubSection */
  last?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-foreground-muted uppercase tracking-wider mb-1.5">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

// =============================================================================
// FIELD ROW — inline label + value on one line
// =============================================================================

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-foreground-muted">{label}</span>
      <div>{children}</div>
    </div>
  );
}

// =============================================================================
// SELECT FIELD — styled dropdown with chevron
// =============================================================================

export function SelectField({
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      options={options as { value: string; label: string }[]}
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={className}
    />
  );
}

// =============================================================================
// STANDARD INPUT CLASSES — reusable constants
// =============================================================================

export const inputClasses = clsx(
  'w-full text-sm text-foreground bg-background border border-default rounded-md',
  'px-3 py-1.5 placeholder:text-foreground-subtle',
  'focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus transition-default',
);

export const textareaClasses = clsx(inputClasses, 'resize-y');

export const numberInputClasses = inputClasses;
