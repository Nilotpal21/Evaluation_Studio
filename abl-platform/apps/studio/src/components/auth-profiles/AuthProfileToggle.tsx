/**
 * AuthProfileToggle Component
 *
 * Shared toggle switch for enabling/disabling auth profile mode.
 * Wraps the shared Toggle component with a justify-between layout.
 * Provides proper accessibility attributes via the Toggle component.
 */

import { clsx } from 'clsx';
import { Toggle } from '../ui/Toggle';

interface AuthProfileToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export function AuthProfileToggle({
  enabled,
  onToggle,
  label = 'Use Auth Profile',
  disabled = false,
  className,
}: AuthProfileToggleProps) {
  return (
    <div className={clsx('flex items-center justify-between', className)}>
      <span className="text-sm text-foreground">{label}</span>
      <Toggle checked={enabled} onChange={onToggle} disabled={disabled} ariaLabel={label} />
    </div>
  );
}
