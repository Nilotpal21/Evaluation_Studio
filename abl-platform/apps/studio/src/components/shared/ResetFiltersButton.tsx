'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Button } from '../ui/Button';

interface ResetFiltersButtonProps {
  count: number;
  onClick: () => void;
  className?: string;
}

export function ResetFiltersButton({ count, onClick, className }: ResetFiltersButtonProps) {
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!announcement) return undefined;

    const timeoutId = window.setTimeout(() => setAnnouncement(''), 1_500);
    return () => window.clearTimeout(timeoutId);
  }, [announcement]);

  if (count <= 0) {
    return null;
  }

  const handleClick = () => {
    onClick();
    setAnnouncement('Filters reset to defaults');
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleClick}
        aria-label={`Reset ${count} active ${count === 1 ? 'filter' : 'filters'} to defaults`}
        className={clsx(
          'animate-fade-in border border-default bg-background-subtle text-muted shadow-sm hover:text-foreground hover:bg-background-muted',
          className,
        )}
      >
        <span>Reset filters</span>
        <span className="rounded-full bg-accent-subtle px-1.5 py-0.5 text-xs font-medium text-accent">
          {count}
        </span>
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
