/**
 * NewProjectDropdown Component
 *
 * Replaces the simple "New Project" button with a dropdown offering:
 * 1. Start with Arch (AI-guided, recommended)
 * 2. Blank Project (manual setup)
 * 3. From Template (pre-built domain starters)
 */

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Sparkles, FileText, LayoutTemplate, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';

interface NewProjectDropdownProps {
  onStartWithArch: () => void;
  onBlankProject: () => void;
  onFromTemplate: () => void;
}

export function NewProjectDropdown({
  onStartWithArch,
  onBlankProject,
  onFromTemplate,
}: NewProjectDropdownProps) {
  const t = useTranslations('creation.new_project_dropdown');
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <Button icon={<Plus className="w-4 h-4" />} onClick={() => setIsOpen(!isOpen)}>
        {t('title')}
        <ChevronDown
          className={clsx('w-3.5 h-3.5 ml-0.5 transition-default', isOpen && 'rotate-180')}
        />
      </Button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 top-full mt-2 w-72 bg-background-elevated border border-default rounded-xl shadow-xl z-50 overflow-hidden"
          >
            <DropdownOption
              icon={<Sparkles className="w-4 h-4" />}
              label={t('start_with_arch')}
              description={t('ai_designs_your_project')}
              badge={t('recommended')}
              onClick={() => {
                onStartWithArch();
                setIsOpen(false);
              }}
              highlighted
            />
            <div className="h-px bg-border-muted" />
            <DropdownOption
              icon={<FileText className="w-4 h-4" />}
              label={t('blank_project')}
              description={t('start_from_scratch')}
              onClick={() => {
                onBlankProject();
                setIsOpen(false);
              }}
            />
            <div className="h-px bg-border-muted" />
            <DropdownOption
              icon={<LayoutTemplate className="w-4 h-4" />}
              label={t('from_template')}
              description={t('template_domains')}
              onClick={() => {
                onFromTemplate();
                setIsOpen(false);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DropdownOption({
  icon,
  label,
  description,
  badge,
  onClick,
  highlighted,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  badge?: string;
  onClick: () => void;
  highlighted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full flex items-start gap-3 px-4 py-3 text-left transition-default',
        'hover:bg-background-subtle',
        highlighted && 'bg-purple-subtle/30',
      )}
    >
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
          highlighted ? 'bg-purple-subtle text-purple' : 'bg-background-muted text-muted',
        )}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'text-sm font-medium',
              highlighted ? 'text-foreground' : 'text-foreground',
            )}
          >
            {label}
          </span>
          {badge && (
            <span className="text-xs font-medium text-purple bg-purple-subtle px-1.5 py-0.5 rounded-full">
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-muted mt-0.5">{description}</p>
      </div>
    </button>
  );
}
