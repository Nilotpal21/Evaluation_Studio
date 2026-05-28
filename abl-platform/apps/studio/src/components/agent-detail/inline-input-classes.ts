import { clsx } from 'clsx';

/**
 * Shared inline input/select class constants for agent-detail sections.
 *
 * These are compact (py-1.5) form controls used in dense inline contexts
 * where full Radix Select popovers would be disruptive.
 */

export const INLINE_INPUT_CLASSES = clsx(
  'w-full rounded-lg border bg-background-subtle px-3 py-1.5',
  'text-sm text-foreground placeholder:text-subtle',
  'focus:border-border-focus focus:ring-1 focus:ring-border-focus focus:outline-none',
  'transition-default border-default',
);

export const INLINE_SELECT_CLASSES = clsx(
  'w-full appearance-none rounded-lg border bg-background-subtle px-3 py-1.5 pr-8',
  'text-sm text-foreground',
  'focus:border-border-focus focus:ring-1 focus:ring-border-focus focus:outline-none',
  'transition-default border-default',
);

export const INLINE_TEXTAREA_CLASSES = clsx(INLINE_INPUT_CLASSES, 'resize-y');
