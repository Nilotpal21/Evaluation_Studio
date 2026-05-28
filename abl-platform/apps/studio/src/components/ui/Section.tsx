/**
 * Section Component
 *
 * Modern card-based section with optional header, description, actions, and collapsible content.
 * Used for organizing content into clean, visually distinct areas.
 */

import { ReactNode, useState } from 'react';
import { ChevronDown, ChevronUp, Info } from 'lucide-react';

interface SectionProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  helpText?: string;
  variant?: 'default' | 'elevated' | 'flat';
  noPadding?: boolean;
  onExpand?: () => void;
}

export function Section({
  title,
  description,
  icon,
  actions,
  children,
  className = '',
  collapsible = false,
  defaultCollapsed = false,
  helpText,
  variant = 'default',
  noPadding = false,
  onExpand,
}: SectionProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const handleToggle = () => {
    const newCollapsedState = !isCollapsed;
    setIsCollapsed(newCollapsedState);
    // Call onExpand when expanding (going from collapsed to expanded)
    if (!newCollapsedState && onExpand) {
      onExpand();
    }
  };

  const variantClasses = {
    default: 'bg-background-elevated border border-default shadow-sm',
    elevated: 'bg-background-elevated border border-default shadow-md',
    flat: 'bg-background-muted',
  };

  const hasHeader = title || icon || actions || collapsible;

  return (
    <div className={`rounded-lg ${variantClasses[variant]} ${className}`}>
      {hasHeader && (
        <div
          className={`flex items-start justify-between gap-4 ${noPadding ? 'p-4' : 'px-5 py-4'} ${
            collapsible
              ? 'cursor-pointer select-none hover:bg-background-muted/50 transition-colors'
              : ''
          }`}
          onClick={collapsible ? handleToggle : undefined}
        >
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {icon && <div className="flex-shrink-0 mt-0.5 text-accent">{icon}</div>}
            <div className="flex-1 min-w-0">
              {title && (
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  {title}
                  {helpText && (
                    <div className="group relative">
                      <Info className="w-3.5 h-3.5 text-muted hover:text-foreground transition-colors cursor-help" />
                      <div className="absolute left-0 top-full mt-1 w-72 p-3 bg-background-elevated border border-default rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 text-xs text-muted z-50">
                        {helpText}
                      </div>
                    </div>
                  )}
                </h3>
              )}
              {description && (
                <p className="text-xs text-muted mt-1 leading-relaxed">{description}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {actions && <div className="flex items-center gap-2">{actions}</div>}
            {collapsible && (
              <button
                className="p-1 hover:bg-background-muted rounded transition-colors"
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              >
                {isCollapsed ? (
                  <ChevronDown className="w-4 h-4 text-muted" />
                ) : (
                  <ChevronUp className="w-4 h-4 text-muted" />
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {(!collapsible || !isCollapsed) && (
        <div
          className={`${hasHeader ? `border-t border-default ${noPadding ? 'p-4' : 'px-5 py-4'}` : noPadding ? 'p-4' : 'p-5'}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * SectionGroup - Groups multiple sections with consistent spacing
 */
interface SectionGroupProps {
  children: ReactNode;
  className?: string;
  spacing?: 'sm' | 'md' | 'lg';
}

export function SectionGroup({ children, className = '', spacing = 'md' }: SectionGroupProps) {
  const spacingClasses = {
    sm: 'space-y-3',
    md: 'space-y-4',
    lg: 'space-y-6',
  };

  return <div className={`${spacingClasses[spacing]} ${className}`}>{children}</div>;
}

/**
 * SectionGrid - Responsive grid layout for sections
 */
interface SectionGridProps {
  children: ReactNode;
  columns?: 1 | 2 | 3;
  className?: string;
}

export function SectionGrid({ children, columns = 2, className = '' }: SectionGridProps) {
  const columnClasses = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 lg:grid-cols-2',
    3: 'grid-cols-1 lg:grid-cols-3',
  };

  return <div className={`grid ${columnClasses[columns]} gap-4 ${className}`}>{children}</div>;
}
