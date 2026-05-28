'use client';

/**
 * ITAdminGuide
 *
 * Collapsible guide section: "Don't have an app registration?"
 * Three delivery mechanisms with clear visual hierarchy:
 *   1. Copy Request to Share (PRIMARY) — paste into Slack/Teams/ServiceNow/email
 *   2. Download Security Review Document (SECONDARY) — comprehensive artifact
 *   3. Open in Email Client (TERTIARY) — short mailto fallback
 * Plus self-service 6-step guide.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  FileText,
  Mail,
  BookOpen,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

interface ITAdminGuideProps {
  /** Clipboard text to copy (full request with justifications) */
  clipboardText: string;
  /** Callback to download the Security Review Document */
  onDownloadSecurityReview: () => void;
  /** Callback to open mailto: with short email */
  onOpenEmail: () => void;
  /** Loading state for email generation */
  loading?: boolean;
}

const SELF_SERVICE_STEPS = [
  'admin_guide_step_1',
  'admin_guide_step_2',
  'admin_guide_step_3',
  'admin_guide_step_4',
  'admin_guide_step_5',
  'admin_guide_step_6',
] as const;

export function ITAdminGuide({
  clipboardText,
  onDownloadSecurityReview,
  onOpenEmail,
  loading = false,
}: ITAdminGuideProps) {
  const t = useTranslations('search_ai.sharepoint.connect');
  const [expanded, setExpanded] = useState(false);
  const [showSelfService, setShowSelfService] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyRequest = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(clipboardText);
      setCopied(true);
      toast.success(t('admin_guide_copy_success'));
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error(t('admin_guide_copy_error'));
    }
  }, [clipboardText, t]);

  return (
    <div className="mt-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        className="text-muted hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        {t('admin_guide_title')}
      </Button>

      {expanded && (
        <div className="mt-3 space-y-3 pl-2">
          {/* PRIMARY: Copy Request to Share */}
          <Card hoverable={false} padding="md">
            <div className="flex items-start gap-3">
              <ClipboardCopy className="w-5 h-5 text-accent shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{t('admin_guide_copy_title')}</p>
                <p className="text-xs text-muted mt-0.5">{t('admin_guide_copy_description')}</p>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCopyRequest}
                  icon={
                    copied ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <ClipboardCopy className="w-3.5 h-3.5" />
                    )
                  }
                  className="mt-2"
                >
                  {copied ? t('admin_guide_copy_copied') : t('admin_guide_copy_button')}
                </Button>
              </div>
            </div>
          </Card>

          {/* SECONDARY: Download Security Review Document */}
          <Card hoverable={false} padding="md">
            <div className="flex items-start gap-3">
              <FileText className="w-5 h-5 text-accent shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{t('admin_guide_doc_title')}</p>
                <p className="text-xs text-muted mt-0.5">{t('admin_guide_doc_description')}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onDownloadSecurityReview}
                  icon={<FileText className="w-3.5 h-3.5" />}
                  className="mt-2"
                >
                  {t('admin_guide_doc_button')}
                </Button>
              </div>
            </div>
          </Card>

          {/* TERTIARY: Open in Email Client */}
          <div className="pl-1">
            <button
              type="button"
              onClick={onOpenEmail}
              disabled={loading}
              className="text-xs text-muted hover:text-foreground transition-default flex items-center gap-1.5"
            >
              <Mail className="w-3.5 h-3.5" />
              {t('admin_guide_email_link')}
            </button>
          </div>

          {/* Self-service guide */}
          <Card hoverable={false} padding="md">
            <div className="flex items-start gap-3">
              <BookOpen className="w-5 h-5 text-accent shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{t('admin_guide_self_title')}</p>
                <p className="text-xs text-muted mt-0.5">{t('admin_guide_self_description')}</p>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setShowSelfService(!showSelfService)}
                  className="mt-2 text-muted"
                >
                  {showSelfService ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                  {showSelfService ? t('admin_guide_hide_steps') : t('admin_guide_show_steps')}
                </Button>
                {showSelfService && (
                  <ol className="mt-2 space-y-1.5 text-xs text-muted list-decimal list-inside">
                    {SELF_SERVICE_STEPS.map((key) => (
                      <li key={key}>{t(key)}</li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
