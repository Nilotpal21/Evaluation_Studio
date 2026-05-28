/**
 * PageHeader Component
 *
 * Title + description + actions bar used on every page.
 */

import { clsx } from 'clsx';

interface PageHeaderProps {
  title: string;
  description?: string;
  beforeActions?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  beforeActions,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold text-foreground truncate tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {(beforeActions || actions) && (
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end lg:self-start">
          {beforeActions}
          {actions}
        </div>
      )}
    </div>
  );
}
